// src/config/redis.js
// Centralized Redis connection configuration
// Uses ioredis for robust Redis client with auto-reconnect

import Redis from "ioredis";
import { logger } from "../utils/logger.js";

let redisClient = null;

/**
 * Creates and returns a singleton Redis client.
 * ioredis automatically handles reconnections with exponential backoff.
 */
export const getRedisClient = () => {
  if (redisClient) return redisClient;

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

  redisClient = new Redis(redisUrl, {
    password: process.env.REDIS_PASSWORD || undefined,
    // Retry strategy: exponential backoff capped at 3s
    retryStrategy: (times) => {
      const delay = Math.min(times * 100, 3000);
      logger.warn(`Redis reconnecting attempt ${times}, delay: ${delay}ms`);
      return delay;
    },
    // Max reconnect attempts before giving up
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  redisClient.on("connect", () => {
    logger.info("✅ Redis connected successfully");
  });

  redisClient.on("ready", () => {
    logger.info("✅ Redis client ready to accept commands");
  });

  redisClient.on("error", (err) => {
    logger.error(`❌ Redis error: ${err.message}`);
  });

  redisClient.on("close", () => {
    logger.warn("⚠️  Redis connection closed");
  });

  redisClient.on("reconnecting", () => {
    logger.warn("🔄 Redis reconnecting...");
  });

  return redisClient;
};

/**
 * Gracefully closes the Redis connection.
 * Called during server shutdown.
 */
export const closeRedisConnection = async () => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info("Redis connection closed gracefully");
  }
};
