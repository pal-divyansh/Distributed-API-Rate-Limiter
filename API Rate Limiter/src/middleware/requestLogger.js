// src/middleware/requestLogger.js
// HTTP request logging middleware.
// Logs each incoming request with metadata and response time.

import { logger } from "../utils/logger.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Assigns a unique request ID and logs all incoming requests.
 * Response time is calculated using process.hrtime for nanosecond precision.
 */
export const requestLogger = (req, res, next) => {
  // Unique ID for request tracing (useful in distributed systems)
  req.requestId = uuidv4();
  res.set("X-Request-ID", req.requestId);

  const start = process.hrtime.bigint();

  // Extract real IP (works behind Nginx)
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.ip ||
    "unknown";

  // Log on response finish (captures status code + duration)
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const logLevel = res.statusCode >= 400 ? "warn" : "info";

    logger[logLevel](`${req.method} ${req.path}`, {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      duration: `${durationMs.toFixed(2)}ms`,
      ip,
      userAgent: req.headers["user-agent"]?.substring(0, 80),
      apiKey: req.headers["x-api-key"] ? "[PRESENT]" : "[NONE]",
    });
  });

  next();
};
