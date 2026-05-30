// src/config/rateLimiter.js
// Centralized rate limiter configuration loaded from environment variables

export const rateLimiterConfig = {
  // Fixed / Sliding Window
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, // 1 minute
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 10,
  slidingWindowEnabled: process.env.SLIDING_WINDOW_ENABLED === "true",

  // Token Bucket
  tokenBucket: {
    capacity: parseInt(process.env.TOKEN_BUCKET_CAPACITY) || 20,
    refillRate: parseInt(process.env.TOKEN_BUCKET_REFILL_RATE) || 5, // tokens per second
  },

  // API Key based limits (higher quota for authenticated clients)
  apiKeyLimit: parseInt(process.env.API_KEY_LIMIT) || 100,

  // Redis key prefix for namespacing
  keyPrefix: "rl",

  // TTL buffer: extra seconds added to Redis key TTL to avoid edge cases
  ttlBuffer: 5,
};
