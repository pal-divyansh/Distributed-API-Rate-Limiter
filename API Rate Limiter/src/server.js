// src/server.js
// Application entry point.
// Starts the HTTP server and manages graceful shutdown.

import "dotenv/config";
import { createApp } from "./app.js";
import { getRedisClient, closeRedisConnection } from "./config/redis.js";
import { logger } from "./utils/logger.js";

const PORT = parseInt(process.env.PORT) || 3000;

const start = async () => {
  // Pre-warm Redis connection before accepting traffic
  logger.info("Connecting to Redis...");
  const redis = getRedisClient();

  // Wait for Redis to be ready (max 10 seconds)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Redis connection timeout")), 10000);
    redis.once("ready", () => { clearTimeout(timeout); resolve(); });
    redis.once("error", (err) => { clearTimeout(timeout); reject(err); });
    // If already connected
    if (redis.status === "ready") { clearTimeout(timeout); resolve(); }
  });

  const app = createApp();

  const server = app.listen(PORT, () => {
    logger.info(`🚀 Rate Limiter API running on port ${PORT}`, {
      port: PORT,
      env: process.env.NODE_ENV || "development",
      pid: process.pid,
      nodeVersion: process.version,
    });
  });

  // ── Graceful Shutdown ──────────────────────────────────
  // Ensures in-flight requests complete before shutting down.
  // Docker sends SIGTERM when stopping a container.
  const shutdown = async (signal) => {
    logger.info(`${signal} received — initiating graceful shutdown...`);

    server.close(async () => {
      logger.info("HTTP server closed (no more incoming connections)");

      try {
        await closeRedisConnection();
        logger.info("✅ Shutdown complete");
        process.exit(0);
      } catch (err) {
        logger.error(`Error during shutdown: ${err.message}`);
        process.exit(1);
      }
    });

    // Force kill after 15 seconds if graceful shutdown hangs
    setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, 15000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Log unhandled promise rejections (don't crash, but alert)
  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled Promise Rejection: ${reason}`);
  });

  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught Exception: ${err.message}`);
    process.exit(1);
  });
};

start().catch((err) => {
  logger.error(`Failed to start server: ${err.message}`);
  process.exit(1);
});
