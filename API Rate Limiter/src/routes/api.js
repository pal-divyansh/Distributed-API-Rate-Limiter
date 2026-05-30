// src/routes/api.js
// All API route definitions.

import express from "express";
import os from "os";
import { getRedisClient } from "../config/redis.js";
import { rateLimiterConfig } from "../config/rateLimiter.js";
import { getAnalytics } from "../services/rateLimiterService.js";
import {
  rateLimiterMiddleware,
  tokenBucketMiddleware,
  strictRateLimiterMiddleware,
} from "../middleware/rateLimiter.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { logger } from "../utils/logger.js";

const router = express.Router();

// ─────────────────────────────────────────────
// GET /
// Public test route — not rate limited
// ─────────────────────────────────────────────
router.get("/", (req, res) => {
  sendSuccess(res, {
    message: "🚀 Distributed API Rate Limiter is running!",
    version: "1.0.0",
    instance: {
      hostname: os.hostname(),
      pid: process.pid,
      platform: process.platform,
    },
    endpoints: {
      root: "GET /",
      health: "GET /health",
      protected: "GET /protected",
      protected_burst: "GET /protected/burst",
      protected_strict: "GET /protected/strict",
      admin_analytics: "GET /admin/analytics",
      admin_metrics: "GET /admin/metrics",
      admin_reset: "DELETE /admin/reset/:identifier",
    },
    rateLimitConfig: {
      algorithm: rateLimiterConfig.slidingWindowEnabled
        ? "Sliding Window"
        : "Fixed Window",
      maxRequests: rateLimiterConfig.maxRequests,
      windowMs: rateLimiterConfig.windowMs,
    },
  });
});

// ─────────────────────────────────────────────
// GET /health
// Health check — no rate limiting, used by Docker/Nginx healthchecks
// ─────────────────────────────────────────────
router.get("/health", async (req, res) => {
  let redisStatus = "disconnected";
  let redisLatencyMs = null;

  try {
    const redis = getRedisClient();
    const start = Date.now();
    await redis.ping();
    redisLatencyMs = Date.now() - start;
    redisStatus = "connected";
  } catch {
    redisStatus = "error";
  }

  const healthy = redisStatus === "connected";

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    status: healthy ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime())}s`,
    instance: {
      hostname: os.hostname(),
      pid: process.pid,
      memory: {
        heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
      },
      cpuLoad: os.loadavg()[0].toFixed(2),
    },
    dependencies: {
      redis: {
        status: redisStatus,
        latency: redisLatencyMs !== null ? `${redisLatencyMs}ms` : null,
      },
    },
  });
});

// ─────────────────────────────────────────────
// GET /protected
// Rate-limited route using sliding window (default)
// ─────────────────────────────────────────────
router.get("/protected", rateLimiterMiddleware, (req, res) => {
  sendSuccess(res, {
    message: "Access granted to protected resource",
    data: {
      secret: "This is your protected data payload ",
      servedBy: os.hostname(), // Shows which container handled the request
      rateLimitInfo: req.rateLimitInfo,
    },
  });
});

// ─────────────────────────────────────────────
// GET /protected/burst
// Uses token bucket — allows bursts up to bucket capacity
// ─────────────────────────────────────────────
router.get("/protected/burst", tokenBucketMiddleware, (req, res) => {
  sendSuccess(res, {
    message: "✅ Token bucket access granted",
    data: {
      note: "This endpoint uses Token Bucket algorithm — tolerates short bursts",
      tokensRemaining: req.rateLimitInfo?.remaining,
      capacity: rateLimiterConfig.tokenBucket.capacity,
      servedBy: os.hostname(),
    },
  });
});

// ─────────────────────────────────────────────
// GET /protected/strict
// Fails closed — returns 503 if Redis is down
// ─────────────────────────────────────────────
router.get("/protected/strict", strictRateLimiterMiddleware, (req, res) => {
  sendSuccess(res, {
    message: "✅ Strict rate-limited access granted",
    data: {
      note: "This endpoint fails CLOSED — returns 503 if Redis is unavailable",
      rateLimitInfo: req.rateLimitInfo,
      servedBy: os.hostname(),
    },
  });
});

// ─────────────────────────────────────────────
// GET /admin/analytics
// Aggregated request analytics from Redis
// Requires admin API key
// ─────────────────────────────────────────────
router.get("/admin/analytics", requireAdminKey, async (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours) || 24, 168); // max 7 days
    const analytics = await getAnalytics(hours);

    const totals = analytics.reduce(
      (acc, h) => {
        acc.total += h.total_requests;
        acc.blocked += h.blocked_requests;
        return acc;
      },
      { total: 0, blocked: 0 }
    );

    sendSuccess(res, {
      analytics: {
        summary: {
          totalRequests: totals.total,
          blockedRequests: totals.blocked,
          allowedRequests: totals.total - totals.blocked,
          blockRate:
            totals.total > 0
              ? `${((totals.blocked / totals.total) * 100).toFixed(1)}%`
              : "0%",
          periodHours: hours,
        },
        hourly: analytics,
      },
    });
  } catch (err) {
    sendError(res, "Failed to retrieve analytics", 500, err.message);
  }
});

// ─────────────────────────────────────────────
// GET /admin/metrics
// Live Redis metrics and system stats
// ─────────────────────────────────────────────
router.get("/admin/metrics", requireAdminKey, async (req, res) => {
  try {
    const redis = getRedisClient();

    // Get Redis server INFO
    const infoRaw = await redis.info();
    const redisInfo = parseRedisInfo(infoRaw);

    // Count active rate limit keys
    const rlKeys = await redis.keys(`${rateLimiterConfig.keyPrefix}:*`);
    const analyticsKeys = await redis.keys("analytics:*");

    sendSuccess(res, {
      metrics: {
        system: {
          hostname: os.hostname(),
          uptime: `${Math.floor(process.uptime())}s`,
          nodeVersion: process.version,
          memory: process.memoryUsage(),
          cpuLoad: os.loadavg(),
        },
        redis: {
          version: redisInfo.redis_version,
          connectedClients: redisInfo.connected_clients,
          usedMemory: redisInfo.used_memory_human,
          totalCommands: redisInfo.total_commands_processed,
          instantOps: redisInfo.instantaneous_ops_per_sec,
          hitRate: redisInfo.keyspace_hits && redisInfo.keyspace_misses
            ? (
                (parseInt(redisInfo.keyspace_hits) /
                  (parseInt(redisInfo.keyspace_hits) +
                    parseInt(redisInfo.keyspace_misses))) *
                100
              ).toFixed(1) + "%"
            : "N/A",
        },
        rateLimiter: {
          activeKeys: rlKeys.length,
          analyticsKeys: analyticsKeys.length,
          algorithm: rateLimiterConfig.slidingWindowEnabled
            ? "Sliding Window"
            : "Fixed Window",
          config: {
            maxRequests: rateLimiterConfig.maxRequests,
            windowMs: rateLimiterConfig.windowMs,
            tokenBucketCapacity: rateLimiterConfig.tokenBucket.capacity,
          },
        },
      },
    });
  } catch (err) {
    sendError(res, "Failed to retrieve metrics", 500, err.message);
  }
});

// ─────────────────────────────────────────────
// DELETE /admin/reset/:identifier
// Manually reset rate limit for a specific IP/key
// ─────────────────────────────────────────────
router.delete("/admin/reset/:identifier", requireAdminKey, async (req, res) => {
  try {
    const redis = getRedisClient();
    const { identifier } = req.params;
    const prefix = rateLimiterConfig.keyPrefix;

    // Find and delete all rate limit keys for this identifier
    const patterns = [
      `${prefix}:fixed:${identifier}:*`,
      `${prefix}:sliding:${identifier}`,
      `${prefix}:bucket:${identifier}`,
      `${prefix}:apikey:${identifier}`,
    ];

    let deletedCount = 0;
    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
        deletedCount += keys.length;
      }
    }

    logger.info(`Admin reset rate limit for: ${identifier} (${deletedCount} keys deleted)`);

    sendSuccess(res, {
      message: `Rate limit reset for identifier: ${identifier}`,
      deletedKeys: deletedCount,
    });
  } catch (err) {
    sendError(res, "Failed to reset rate limit", 500, err.message);
  }
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/** Middleware: require admin API key */
function requireAdminKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.apiKey;
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({
      success: false,
      error: "Forbidden",
      message: "Valid admin API key required in X-API-Key header",
    });
  }
  next();
}

/** Parse Redis INFO string into a key-value object */
function parseRedisInfo(infoString) {
  const result = {};
  for (const line of infoString.split("\r\n")) {
    if (line && !line.startsWith("#")) {
      const [key, value] = line.split(":");
      if (key && value !== undefined) result[key.trim()] = value.trim();
    }
  }
  return result;
}

export default router;
