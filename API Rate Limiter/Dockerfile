# ────────────────────────────────────────────────────────────────────────────
# Stage 1: Builder
# Install all dependencies (including devDependencies for potential build steps)
# ────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Add security updates
RUN apk update && apk upgrade && apk add --no-cache dumb-init

WORKDIR /app

# Copy package files first for Docker layer caching
# This layer is only rebuilt when package.json changes
COPY package*.json ./

# Install all dependencies
RUN npm ci --only=production && npm cache clean --force

# ────────────────────────────────────────────────────────────────────────────
# Stage 2: Production image
# Lean final image with only what's needed to run the app
# ────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS production

# Use dumb-init as PID 1 to handle signals properly
# Without this, Node.js won't receive SIGTERM from Docker correctly
COPY --from=builder /usr/bin/dumb-init /usr/bin/dumb-init

# Create non-root user for security (never run as root in production)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodeuser -u 1001 -G nodejs

WORKDIR /app

# Copy node_modules from builder (already trimmed to production deps)
COPY --from=builder --chown=nodeuser:nodejs /app/node_modules ./node_modules

# Copy application source
COPY --chown=nodeuser:nodejs src/ ./src/
COPY --chown=nodeuser:nodejs package.json ./

# Switch to non-root user
USER nodeuser

# Expose application port
EXPOSE 3000

# Health check — Docker will mark container unhealthy if this fails
# --interval: check every 30s
# --timeout: fail if no response within 10s
# --start-period: grace period for startup (30s)
# --retries: mark unhealthy after 3 failures
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

# Use dumb-init to wrap Node.js for proper signal forwarding
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "src/server.js"]
