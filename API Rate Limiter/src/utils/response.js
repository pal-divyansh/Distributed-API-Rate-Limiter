// src/utils/response.js
// Standardized API response helpers for consistent JSON structure

/**
 * Send a successful JSON response.
 */
export const sendSuccess = (res, data = {}, statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    timestamp: new Date().toISOString(),
    ...data,
  });
};

/**
 * Send an error JSON response.
 */
export const sendError = (res, message, statusCode = 500, details = null) => {
  const body = {
    success: false,
    error: message,
    timestamp: new Date().toISOString(),
  };
  if (details) body.details = details;
  return res.status(statusCode).json(body);
};

/**
 * Send a 429 Too Many Requests response with rate limit headers.
 * @param {Object} info - Rate limit metadata (limit, remaining, resetTime)
 */
export const sendRateLimitExceeded = (res, info = {}) => {
  const retryAfter = info.retryAfter || 60;

  // Standard rate limit headers (draft-ietf-httpapi-ratelimit-headers)
  res.set({
    "X-RateLimit-Limit": info.limit || 10,
    "X-RateLimit-Remaining": 0,
    "X-RateLimit-Reset": info.resetTime || Date.now() + retryAfter * 1000,
    "Retry-After": retryAfter,
  });

  return res.status(429).json({
    success: false,
    error: "Too Many Requests",
    message: `Rate limit exceeded. You can make ${info.limit} requests per minute.`,
    retryAfter: `${retryAfter} seconds`,
    timestamp: new Date().toISOString(),
  });
};
