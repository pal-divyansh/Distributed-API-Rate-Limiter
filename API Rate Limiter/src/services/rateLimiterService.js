// src/services/rateLimiterService.js
//
// Core distributed rate limiting logic using Redis.
// Implements two algorithms:
//   1. Sliding Window  — precise, fair, memory-efficient
//   2. Token Bucket    — burst-tolerant, smooth throughput
//
// WHY REDIS FOR DISTRIBUTED RATE LIMITING:
// - Redis is single-threaded → atomic operations, no race conditions
// - INCRBY + EXPIRE in a Lua script = consistent across all app instances
// - Sub-millisecond latency — adds <1ms overhead per request
// - Built-in TTL = automatic window resets without cron jobs
// - Horizontal scaling: 10 API instances all talk to 1 Redis = shared state

import { getRedisClient } from "../config/redis.js";
import { rateLimiterConfig } from "../config/rateLimiter.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────
// FIXED WINDOW ALGORITHM
// ─────────────────────────────────────────────
// How it works:
//   Key: rl:fixed:<identifier>:<windowStart>
//   - Increment counter on each request
//   - Set TTL equal to window duration on first request
//   - Block when counter > maxRequests
//
// Drawback: A user can fire 10 requests at 00:59 and 10 more at 01:01
// (20 requests in 2 seconds) — the "boundary burst" problem.

/**
 * Fixed window rate limiter.
 * @returns {{ allowed: boolean, remaining: number, resetTime: number }}
 */
export const fixedWindowCheck = async (identifier) => {
  const redis = getRedisClient();
  const { windowMs, maxRequests, keyPrefix } = rateLimiterConfig;
  const windowSeconds = Math.floor(windowMs / 1000);

  // Window bucket: floor current time to nearest window
  const windowStart = Math.floor(Date.now() / windowMs);
  const key = `${keyPrefix}:fixed:${identifier}:${windowStart}`;

  // Lua script ensures INCR + EXPIRE are atomic (no race condition)
  // If two requests arrive simultaneously, both see the correct counter
  const luaScript = `
    local current = redis.call('INCR', KEYS[1])
    if current == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    return current
  `;

  const count = await redis.eval(luaScript, 1, key, windowSeconds + rateLimiterConfig.ttlBuffer);
  const resetTime = (windowStart + 1) * windowMs;

  return {
    allowed: count <= maxRequests,
    remaining: Math.max(0, maxRequests - count),
    limit: maxRequests,
    count,
    resetTime,
    retryAfter: Math.ceil((resetTime - Date.now()) / 1000),
  };
};

// ─────────────────────────────────────────────
// SLIDING WINDOW ALGORITHM (Preferred)
// ─────────────────────────────────────────────
// How it works:
//   Key: rl:sliding:<identifier>  (a Redis Sorted Set)
//   - Score = timestamp of each request
//   - On each request:
//       1. Remove entries older than (now - windowMs)
//       2. Count remaining entries
//       3. If count < maxRequests → ZADD current timestamp → allow
//       4. Otherwise → block
//   - ZSET TTL is reset on each request
//
// Advantage: No boundary burst problem. The window always looks
// at the LAST 60 seconds regardless of clock boundaries.

/**
 * Sliding window rate limiter using Redis Sorted Sets.
 * @returns {{ allowed: boolean, remaining: number, resetTime: number }}
 */
export const slidingWindowCheck = async (identifier) => {
  const redis = getRedisClient();
  const { windowMs, maxRequests, keyPrefix } = rateLimiterConfig;
  const windowSeconds = Math.floor(windowMs / 1000);

  const key = `${keyPrefix}:sliding:${identifier}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  // Atomic Lua script:
  // 1. ZREMRANGEBYSCORE — purge expired entries (older than windowStart)
  // 2. ZCARD — count active entries in window
  // 3. Conditionally ZADD current timestamp as a new member
  // 4. EXPIRE — reset TTL to keep key alive
  const luaScript = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local windowStart = tonumber(ARGV[2])
    local maxRequests = tonumber(ARGV[3])
    local ttl = tonumber(ARGV[4])

    -- Remove timestamps outside the current window
    redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)

    -- Count requests in the current window
    local count = redis.call('ZCARD', key)

    if count < maxRequests then
      -- Allow: add this request with current timestamp as both score and member
      -- Using now+count as member to handle same-millisecond requests uniquely
      redis.call('ZADD', key, now, now .. '-' .. count)
      redis.call('EXPIRE', key, ttl)
      return {1, count + 1}
    else
      -- Deny: return current count without adding
      return {0, count}
    end
  `;

  const [allowed, count] = await redis.eval(
    luaScript, 1, key,
    now, windowStart, maxRequests,
    windowSeconds + rateLimiterConfig.ttlBuffer
  );

  // Estimate when the oldest entry will fall outside the window
  const oldestEntry = await redis.zrange(key, 0, 0, "WITHSCORES");
  const oldestScore = oldestEntry.length > 1 ? parseFloat(oldestEntry[1]) : now;
  const resetTime = oldestScore + windowMs;

  return {
    allowed: allowed === 1,
    remaining: Math.max(0, maxRequests - count),
    limit: maxRequests,
    count,
    resetTime,
    retryAfter: Math.ceil((resetTime - now) / 1000),
  };
};

// ─────────────────────────────────────────────
// TOKEN BUCKET ALGORITHM
// ─────────────────────────────────────────────
// How it works:
//   Key: rl:bucket:<identifier>  → { tokens, lastRefill }
//   - Bucket holds up to `capacity` tokens
//   - Tokens refill at `refillRate` per second
//   - Each request consumes 1 token
//   - If tokens >= 1 → allow, else → block
//
// Advantage: Allows short bursts (up to capacity) while enforcing
// a long-term average rate. Ideal for APIs used by human clients.

/**
 * Token bucket rate limiter.
 * @returns {{ allowed: boolean, remaining: number }}
 */
export const tokenBucketCheck = async (identifier) => {
  const redis = getRedisClient();
  const { capacity, refillRate } = rateLimiterConfig.tokenBucket;
  const key = `${rateLimiterConfig.keyPrefix}:bucket:${identifier}`;
  const now = Date.now() / 1000; // seconds

  const luaScript = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refillRate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])

    local data = redis.call('HMGET', key, 'tokens', 'lastRefill')
    local tokens = tonumber(data[1]) or capacity
    local lastRefill = tonumber(data[2]) or now

    -- Calculate tokens to add based on elapsed time
    local elapsed = now - lastRefill
    local newTokens = math.min(capacity, tokens + elapsed * refillRate)

    if newTokens >= 1 then
      -- Consume one token
      redis.call('HMSET', key, 'tokens', newTokens - 1, 'lastRefill', now)
      redis.call('EXPIRE', key, 3600)
      return {1, math.floor(newTokens - 1)}
    else
      -- Not enough tokens
      redis.call('HMSET', key, 'tokens', newTokens, 'lastRefill', now)
      redis.call('EXPIRE', key, 3600)
      return {0, 0}
    end
  `;

  const [allowed, remaining] = await redis.eval(
    luaScript, 1, key, capacity, refillRate, now
  );

  return {
    allowed: allowed === 1,
    remaining,
    limit: capacity,
    retryAfter: Math.ceil((1 - remaining) / refillRate),
  };
};

// ─────────────────────────────────────────────
// API KEY BASED RATE LIMITER
// ─────────────────────────────────────────────
// API keys get higher rate limits than anonymous IPs.
// Uses sliding window internally with a higher maxRequests.

/**
 * API key rate limiter with elevated quota.
 */
export const apiKeyCheck = async (apiKey) => {
  const redis = getRedisClient();
  const { windowMs, keyPrefix, apiKeyLimit, ttlBuffer } = rateLimiterConfig;
  const windowSeconds = Math.floor(windowMs / 1000);
  const key = `${keyPrefix}:apikey:${apiKey}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  const luaScript = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local windowStart = tonumber(ARGV[2])
    local maxRequests = tonumber(ARGV[3])
    local ttl = tonumber(ARGV[4])

    redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
    local count = redis.call('ZCARD', key)

    if count < maxRequests then
      redis.call('ZADD', key, now, now .. '-' .. count)
      redis.call('EXPIRE', key, ttl)
      return {1, count + 1}
    else
      return {0, count}
    end
  `;

  const [allowed, count] = await redis.eval(
    luaScript, 1, key, now, windowStart,
    apiKeyLimit, windowSeconds + ttlBuffer
  );

  return {
    allowed: allowed === 1,
    remaining: Math.max(0, apiKeyLimit - count),
    limit: apiKeyLimit,
    count,
    retryAfter: allowed ? 0 : Math.ceil(windowSeconds / 2),
  };
};

// ─────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────

/**
 * Track request analytics in Redis.
 * Stores hit/block counts per identifier per hour.
 */
export const trackAnalytics = async (identifier, blocked = false) => {
  const redis = getRedisClient();
  const hour = Math.floor(Date.now() / 3600000);
  const statsKey = `analytics:${hour}`;

  try {
    const pipeline = redis.pipeline();
    pipeline.hincrby(statsKey, "total_requests", 1);
    if (blocked) pipeline.hincrby(statsKey, "blocked_requests", 1);
    pipeline.hincrby(statsKey, `ip:${identifier}`, 1);
    pipeline.expire(statsKey, 86400); // keep 24 hours
    await pipeline.exec();
  } catch (err) {
    // Analytics failure should never affect the main request
    logger.warn(`Analytics tracking failed: ${err.message}`);
  }
};

/**
 * Get aggregated analytics for the last N hours.
 */
export const getAnalytics = async (hours = 24) => {
  const redis = getRedisClient();
  const now = Math.floor(Date.now() / 3600000);
  const results = [];

  for (let i = 0; i < hours; i++) {
    const hour = now - i;
    const key = `analytics:${hour}`;
    try {
      const data = await redis.hgetall(key);
      if (data && Object.keys(data).length > 0) {
        results.push({
          hour: new Date(hour * 3600000).toISOString(),
          total_requests: parseInt(data.total_requests || 0),
          blocked_requests: parseInt(data.blocked_requests || 0),
        });
      }
    } catch {
      // skip missing hours
    }
  }

  return results.reverse(); // chronological order
};
