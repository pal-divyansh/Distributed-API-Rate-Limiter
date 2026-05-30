// src/utils/logger.js
// Centralized structured logger using Winston
// Outputs JSON in production, colorized text in development

import winston from "winston";

const { combine, timestamp, printf, colorize, json } = winston.format;

const isProduction = process.env.NODE_ENV === "production";

// Custom format for development: colorized and human-readable
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: "HH:mm:ss" }),
  printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : "";
    return `[${timestamp}] ${level}: ${message} ${metaStr}`;
  })
);

// JSON format for production: structured, machine-parseable
const prodFormat = combine(timestamp(), json());

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: isProduction ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console(),
    // In production, you'd add file/cloud transports here
    // new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
  ],
});
