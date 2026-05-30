// src/middleware/errorHandler.js
// Centralized error handling middleware.
// Catches all unhandled errors and returns a consistent JSON response.

import { logger } from "../utils/logger.js";

/**
 * Catch-all error middleware.
 * Must be registered LAST in the Express middleware chain (after all routes).
 * Express identifies error middleware by the 4-argument signature (err, req, res, next).
 */
export const errorHandler = (err, req, res, next) => {
  // Determine appropriate status code
  const statusCode = err.statusCode || err.status || 500;

  logger.error("Unhandled error", {
    requestId: req.requestId,
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    path: req.originalUrl,
    method: req.method,
  });

  const response = {
    success: false,
    error: statusCode === 500 ? "Internal Server Error" : err.message,
    timestamp: new Date().toISOString(),
    requestId: req.requestId,
  };

  // Include stack trace in development for easier debugging
  if (process.env.NODE_ENV === "development" && err.stack) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};

/**
 * 404 handler — catches requests to undefined routes.
 * Must be registered AFTER all routes but BEFORE errorHandler.
 */
export const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: "Not Found",
    message: `Route ${req.method} ${req.originalUrl} does not exist`,
    timestamp: new Date().toISOString(),
  });
};
