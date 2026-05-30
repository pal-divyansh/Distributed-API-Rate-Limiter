// src/app.js
// Express application factory.
// Separated from server.js to allow easy testing without starting a real server.

import express from "express";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import apiRoutes from "./routes/api.js";

export const createApp = () => {
  const app = express();

  // ── Core middleware ──────────────────────────────────
  app.use(express.json({ limit: "10kb" }));          // Parse JSON bodies
  app.use(express.urlencoded({ extended: true }));   // Parse URL-encoded bodies

  // Trust proxy headers (required when behind Nginx/load balancer)
  // This makes req.ip return the real client IP from X-Forwarded-For
  app.set("trust proxy", 1);

  // Remove X-Powered-By for security (don't expose Express)
  app.disable("x-powered-by");

  // ── Logging ─────────────────────────────────────────
  app.use(requestLogger);

  // ── Routes ──────────────────────────────────────────
  app.use("/", apiRoutes);

  // ── Error handling (must be last) ───────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
