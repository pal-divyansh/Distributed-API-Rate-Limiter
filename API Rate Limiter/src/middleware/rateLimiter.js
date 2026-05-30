// src/middleware/rateLimiter.js
// Express middleware that intercepts requests and applies rate limiting.
// Supports three modes:
//   - Sliding window (default, recommended)
//   - Fixed window
//   - Token bucket (for burst-tolerant APIs)

import {
  slidingWindowCheck,
  fixedWindowCheck,
  tokenBucketCheck,
  apiKeyCheck,
  trackAnalytics,
} from "../services/rateLimiterService.js";
import { sendRateLimitExceeded } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import { rateLimiterConfig } from "../config/rateLimiter.js";

/**
 * Extract client identifier for rate limiting.
 * Priority: X-API-Key header → X-Forwarded-For (behind proxy) → req.ip
 */
const getIdentifier = (req) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey) return { type: "apiKey", value: apiKey };

  // Support for proxies / load balancers (Nginx sets this)
  const forwarded = req.headers["x-forwarded-for"];
  const ip = forwarded ? forwarded.split(",")[0].trim() : req.ip;

  return { type: "ip", value: ip || "unknown" };
};

/**
 * Attach rate limit info headers to every response (even allowed ones).
 * Helps clients track their quota proactively.
 */
const attachRateLimitHeaders = (res, info) => {
  res.set({
    "X-RateLimit-Limit": info.limit,
    "X-RateLimit-Remaining": info.remaining,
    "X-RateLimit-Reset": info.resetTime || Date.now() + rateLimiterConfig.windowMs,
    "X-RateLimit-Algorithm": rateLimiterConfig.slidingWindowEnabled
      ? "sliding-window"
      : "fixed-window",
  });
};

// ──────────────────────────────────────────────────────────
// MAIN RATE LIMITER MIDDLEWARE (Sliding or Fixed Window)
// ──────────────────────────────────────────────────────────

/**
 * Default rate limiter middleware.
 * Uses sliding window if SLIDING_WINDOW_ENABLED=true, otherwise fixed window.
 */
export const rateLimiterMiddleware = async (req, res, next) => {
  const { type, value: identifier } = getIdentifier(req);

  try {
    let result;

    if (type === "apiKey") {
      // API key clients use a separate, higher-quota limiter
      result = await apiKeyCheck(identifier);
    } else if (rateLimiterConfig.slidingWindowEnabled) {
      result = await slidingWindowCheck(identifier);
    } else {
      result = await fixedWindowCheck(identifier);
    }

    // Always track analytics (non-blocking)
    trackAnalytics(identifier, !result.allowed);

    // Attach headers for both allowed and denied requests
    attachRateLimitHeaders(res, result);

    if (!result.allowed) {
      logger.warn("🚫 Rate limit exceeded", {
        identifier,
        type,
        count: result.count,
        limit: result.limit,
        path: req.path,
        method: req.method,
      });
      return sendRateLimitExceeded(res, result);
    }

    // Pass rate limit info to route handlers if needed
    req.rateLimitInfo = result;
    next();
  } catch (err) {
    // Redis failure should not block requests (fail open strategy)
    // In high-security scenarios, change this to fail closed (return 503)
    logger.error(`Rate limiter error (failing open): ${err.message}`);
    next();
  }
};

// ──────────────────────────────────────────────────────────
// TOKEN BUCKET MIDDLEWARE
// ──────────────────────────────────────────────────────────

/**
 * Token bucket rate limiter middleware.
 * Better for endpoints that need to tolerate short bursts.
 */
export const tokenBucketMiddleware = async (req, res, next) => {
  const { value: identifier } = getIdentifier(req);

  try {
    const result = await tokenBucketCheck(identifier);

    res.set({
      "X-RateLimit-Limit": result.limit,
      "X-RateLimit-Remaining": result.remaining,
      "X-RateLimit-Algorithm": "token-bucket",
    });

    trackAnalytics(identifier, !result.allowed);

    if (!result.allowed) {
      logger.warn("🚫 Token bucket exhausted", {
        identifier,
        path: req.path,
        method: req.method,
      });
      return sendRateLimitExceeded(res, result);
    }

    req.rateLimitInfo = result;
    next();
  } catch (err) {
    logger.error(`Token bucket error (failing open): ${err.message}`);
    next();
  }
};

// ──────────────────────────────────────────────────────────
// STRICT RATE LIMITER (fail closed)
// ──────────────────────────────────────────────────────────

/**
 * Strict rate limiter — returns 503 if Redis is unavailable.
 * Use on high-security endpoints where blocking > bypassing.
 */
export const strictRateLimiterMiddleware = async (req, res, next) => {
  const { type, value: identifier } = getIdentifier(req);

  try {
    const result = rateLimiterConfig.slidingWindowEnabled
      ? await slidingWindowCheck(identifier)
      : await fixedWindowCheck(identifier);

    attachRateLimitHeaders(res, result);
    trackAnalytics(identifier, !result.allowed);

    if (!result.allowed) {
      logger.warn("🚫 Strict rate limit exceeded", { identifier, type, path: req.path });
      return sendRateLimitExceeded(res, result);
    }

    req.rateLimitInfo = result;
    next();
  } catch (err) {
    logger.error(`Strict rate limiter: Redis unavailable → returning 503`);
    res.status(503).json({
      success: false,
      error: "Service temporarily unavailable",
      message: "Rate limiting service is unreachable. Please try again shortly.",
    });
  }
};
