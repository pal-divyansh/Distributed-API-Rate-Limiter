# 🚦 Distributed API Rate Limiter

> A production-grade, horizontally scalable API rate limiter built with **Node.js**, **Express**, **Redis**, and **Docker**. Features sliding window, fixed window, and token bucket algorithms with real-time analytics.

```
Client → Nginx (Load Balancer) → API Instance 1 ─┐
                               → API Instance 2 ─┤─→ Redis (Shared State)
```

---

## 📋 Table of Contents

- [Architecture Overview](#-architecture-overview)
- [Features](#-features)
- [Quick Start](#-quick-start)
- [API Endpoints & Sample Responses](#-api-endpoints--sample-responses)
- [Rate Limiting Algorithms](#-rate-limiting-algorithms)
- [Environment Variables](#-environment-variables)
- [Docker Commands](#-docker-commands)
- [Testing the Rate Limiter](#-testing-the-rate-limiter)
- [Production Scaling](#-production-scaling)
- [Concepts Explained](#-concepts-explained)

---

## 🏗 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Docker Network                           │
│                                                                 │
│   ┌──────────────┐     ┌──────────────┐   ┌──────────────┐     │
│   │   Client     │────▶│   Nginx :80  │──▶│  API 1 :3000 │──┐  │
│   │  (Browser/   │     │ Load Balancer│   └──────────────┘  │  │
│   │   curl/app)  │     │  Round Robin │   ┌──────────────┐  │  │
│   └──────────────┘     │              │──▶│  API 2 :3000 │──┤  │
│                        └──────────────┘   └──────────────┘  │  │
│                                                              ▼  │
│                                              ┌─────────────────┐│
│                                              │  Redis :6379    ││
│                                              │  (Shared State) ││
│                                              │  Rate Limit Keys││
│                                              │  Analytics Data ││
│                                              └─────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Why This Architecture Works at Scale

- **Redis** holds all rate limit counters — every API instance reads and writes to the same store
- **Nginx** distributes requests across instances — adding more API containers increases throughput
- **Lua scripts** in Redis guarantee atomic increment+check operations — no race conditions
- **Graceful shutdown** ensures in-flight requests complete before a container stops

---

## ✨ Features

### Core
- ✅ **3 Rate Limiting Algorithms** — Sliding Window, Fixed Window, Token Bucket
- ✅ **Per-IP limiting** — works behind proxies (reads `X-Forwarded-For`)
- ✅ **API Key limiting** — higher quota for authenticated clients
- ✅ **Redis Lua scripts** — atomic operations, no race conditions
- ✅ **Standard rate limit headers** — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`
- ✅ **Fail-open + fail-closed modes** — choose per endpoint

### Infrastructure
- ✅ **2 API containers** sharing one Redis instance
- ✅ **Nginx load balancer** with health checks and failover
- ✅ **Multi-stage Docker build** — lean production images
- ✅ **Health checks** on all containers
- ✅ **Graceful shutdown** — SIGTERM handling, in-flight request completion

### Observability
- ✅ **Structured JSON logging** (Winston)
- ✅ **Request tracing** — `X-Request-ID` on every response
- ✅ **Analytics endpoint** — hourly hit/block counts
- ✅ **Metrics endpoint** — Redis stats, active keys, memory usage
- ✅ **Admin reset** — manually clear rate limit for any IP/key

---

## 🚀 Quick Start

### Prerequisites

- Docker Desktop or Docker Engine + Compose
- `curl` or any HTTP client for testing

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/distributed-rate-limiter.git
cd distributed-rate-limiter
```

### 2. Configure Environment

```bash
cp .env .env.local
# Edit .env.local — at minimum, change ADMIN_API_KEY
```

### 3. Start All Services

```bash
docker compose up --build -d
```

This starts:
- Redis on port `6379`
- API Instance 1 (internal port `3000`)
- API Instance 2 (internal port `3000`)
- Nginx on port `80` (your public entry point)

### 4. Verify Everything is Running

```bash
docker compose ps
```

```
NAME                     STATUS          PORTS
rate-limiter-nginx       Up (healthy)    0.0.0.0:80->80/tcp
rate-limiter-api1        Up (healthy)    3000/tcp
rate-limiter-api2        Up (healthy)    3000/tcp
rate-limiter-redis       Up (healthy)    0.0.0.0:6379->6379/tcp
```

### 5. Test It

```bash
curl http://localhost/
curl http://localhost/health
curl http://localhost/protected
```

---

## 📡 API Endpoints & Sample Responses

### `GET /` — Root (no rate limit)

```bash
curl http://localhost/
```

```json
{
  "success": true,
  "timestamp": "2024-01-15T10:30:00.000Z",
  "message": "🚀 Distributed API Rate Limiter is running!",
  "version": "1.0.0",
  "instance": {
    "hostname": "rate-limiter-api1",
    "pid": 1,
    "platform": "linux"
  },
  "rateLimitConfig": {
    "algorithm": "Sliding Window",
    "maxRequests": 10,
    "windowMs": 60000
  }
}
```

---

### `GET /health` — Health Check

```bash
curl http://localhost/health
```

```json
{
  "success": true,
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:01.000Z",
  "uptime": "3600s",
  "instance": {
    "hostname": "rate-limiter-api1",
    "memory": { "heapUsed": "42MB", "heapTotal": "64MB" },
    "cpuLoad": "0.05"
  },
  "dependencies": {
    "redis": { "status": "connected", "latency": "1ms" }
  }
}
```

---

### `GET /protected` — Rate-Limited Endpoint (Sliding Window)

```bash
curl http://localhost/protected
```

**Allowed response (HTTP 200):**

```json
{
  "success": true,
  "timestamp": "2024-01-15T10:30:02.000Z",
  "message": "✅ Access granted to protected resource",
  "data": {
    "secret": "This is your protected data payload 🎯",
    "servedBy": "rate-limiter-api1",
    "rateLimitInfo": {
      "allowed": true,
      "remaining": 9,
      "limit": 10,
      "count": 1
    }
  }
}
```

**Rate limit exceeded (HTTP 429):**

```json
{
  "success": false,
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. You can make 10 requests per minute.",
  "retryAfter": "47 seconds",
  "timestamp": "2024-01-15T10:30:45.000Z"
}
```

Response headers:
```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1705315845000
X-RateLimit-Algorithm: sliding-window
Retry-After: 47
```

---

### `GET /protected/burst` — Token Bucket (Burst-Tolerant)

```bash
curl http://localhost/protected/burst
```

```json
{
  "success": true,
  "data": {
    "note": "This endpoint uses Token Bucket algorithm — tolerates short bursts",
    "tokensRemaining": 19,
    "capacity": 20,
    "servedBy": "rate-limiter-api2"
  }
}
```

---

### `GET /admin/analytics` — Request Analytics

```bash
curl -H "X-API-Key: admin-secret-key-change-in-production" \
     http://localhost/admin/analytics?hours=6
```

```json
{
  "success": true,
  "analytics": {
    "summary": {
      "totalRequests": 847,
      "blockedRequests": 123,
      "allowedRequests": 724,
      "blockRate": "14.5%",
      "periodHours": 6
    },
    "hourly": [
      { "hour": "2024-01-15T04:00:00.000Z", "total_requests": 142, "blocked_requests": 21 },
      { "hour": "2024-01-15T05:00:00.000Z", "total_requests": 178, "blocked_requests": 30 }
    ]
  }
}
```

---

### `GET /admin/metrics` — Live System Metrics

```bash
curl -H "X-API-Key: admin-secret-key-change-in-production" \
     http://localhost/admin/metrics
```

```json
{
  "success": true,
  "metrics": {
    "redis": {
      "version": "7.2.0",
      "connectedClients": "2",
      "usedMemory": "2.50M",
      "instantOps": "45",
      "hitRate": "94.2%"
    },
    "rateLimiter": {
      "activeKeys": 38,
      "algorithm": "Sliding Window",
      "config": { "maxRequests": 10, "windowMs": 60000 }
    }
  }
}
```

---

### `DELETE /admin/reset/:identifier` — Reset Rate Limit

```bash
curl -X DELETE \
     -H "X-API-Key: admin-secret-key-change-in-production" \
     http://localhost/admin/reset/192.168.1.100
```

```json
{
  "success": true,
  "message": "Rate limit reset for identifier: 192.168.1.100",
  "deletedKeys": 2
}
```

---

## ⚙️ Rate Limiting Algorithms

### 1. Sliding Window (Default — Recommended)

```
Time: 0s──────────────────────────────────────60s
       └─ Window always = last 60 seconds ──┘

At t=55s: [req@5s, req@20s, req@30s, req@50s, req@55s] = 5 in window
At t=65s: [req@20s, req@30s, req@50s, req@55s, req@65s] = 5 in window
          (req@5s aged out — it's > 60s ago)
```

**Pros:** No boundary burst problem. Precise and fair.  
**Cons:** Higher Redis memory use (stores timestamps per request).

---

### 2. Fixed Window

```
Window 1: [00:00 → 01:00] — 10 requests allowed
Window 2: [01:00 → 02:00] — 10 requests allowed

Problem: 10 requests at 00:59 + 10 at 01:01 = 20 in 2 seconds!
```

**Pros:** Simple, low memory.  
**Cons:** Boundary burst vulnerability.

---

### 3. Token Bucket

```
Capacity: 20 tokens
Refill: 5 tokens/second

t=0s:  20 tokens → make 15 requests → 5 tokens left
t=1s:  5+5 = 10 tokens → make 10 requests → 0 left
t=2s:  0+5 = 5 tokens available again
```

**Pros:** Handles bursts gracefully. Natural for human-driven traffic.  
**Cons:** More complex implementation.

---

## 🔧 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window duration in milliseconds |
| `RATE_LIMIT_MAX_REQUESTS` | `10` | Max requests per window |
| `SLIDING_WINDOW_ENABLED` | `true` | Use sliding window (vs fixed) |
| `TOKEN_BUCKET_CAPACITY` | `20` | Token bucket max tokens |
| `TOKEN_BUCKET_REFILL_RATE` | `5` | Tokens added per second |
| `API_KEY_LIMIT` | `100` | Requests per window for API key clients |
| `ADMIN_API_KEY` | `admin-secret...` | Key for admin endpoints |
| `LOG_LEVEL` | `info` | Winston log level |

---

## 🐳 Docker Commands

```bash
# Start all services (build images if needed)
docker compose up --build -d

# View logs from all services
docker compose logs -f

# View logs from one service
docker compose logs -f api1

# Scale API to 3 instances (update nginx.conf upstream too)
docker compose up --scale api1=1 --scale api2=1

# Stop all services (preserve data)
docker compose stop

# Stop and remove containers + network (preserve Redis data volume)
docker compose down

# Stop and remove EVERYTHING including volumes (wipes Redis data)
docker compose down -v

# Rebuild a single service
docker compose up --build api1 -d

# Execute a command inside a running container
docker compose exec api1 sh
docker compose exec redis redis-cli

# Check container health
docker inspect rate-limiter-api1 --format='{{.State.Health.Status}}'

# View resource usage
docker stats
```

---

## 🧪 Testing the Rate Limiter

### Bash — Burst Test (hit the limit)

```bash
# Fire 15 requests rapidly — should see 429 after request 10
for i in $(seq 1 15); do
  response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost/protected)
  echo "Request $i: HTTP $response"
done
```

Expected output:
```
Request 1:  HTTP 200
Request 2:  HTTP 200
...
Request 10: HTTP 200
Request 11: HTTP 429
Request 12: HTTP 429
...
```

### Bash — Check Rate Limit Headers

```bash
curl -I http://localhost/protected
```

```
HTTP/1.1 200 OK
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 7
X-RateLimit-Reset: 1705315845000
X-RateLimit-Algorithm: sliding-window
X-Request-ID: a3f2b1c4-...
X-Served-By: 172.20.0.3:3000
```

### Bash — Test Load Balancing (see alternating hostnames)

```bash
for i in $(seq 1 6); do
  curl -s http://localhost/protected | python3 -m json.tool | grep servedBy
done
```

```
"servedBy": "rate-limiter-api1"
"servedBy": "rate-limiter-api2"
"servedBy": "rate-limiter-api1"
"servedBy": "rate-limiter-api2"
...
```

### Bash — API Key (higher limit)

```bash
curl -H "X-API-Key: my-client-key-123" http://localhost/protected
```

### Python — Stress Test

```python
import requests
import time

BASE_URL = "http://localhost"

print("Testing rate limiting...")
for i in range(15):
    r = requests.get(f"{BASE_URL}/protected")
    remaining = r.headers.get("X-RateLimit-Remaining", "N/A")
    print(f"Request {i+1:2d}: HTTP {r.status_code} | Remaining: {remaining}")
    time.sleep(0.1)

print("\nWaiting 60 seconds for window reset...")
time.sleep(60)
r = requests.get(f"{BASE_URL}/protected")
print(f"After reset: HTTP {r.status_code}")
```

### Redis CLI — Inspect State

```bash
# Connect to Redis
docker compose exec redis redis-cli

# List all rate limit keys
KEYS rl:*

# View sliding window sorted set for an IP
ZRANGE rl:sliding:127.0.0.1 0 -1 WITHSCORES

# Check TTL remaining on a key
TTL rl:sliding:127.0.0.1

# View analytics for current hour
HGETALL analytics:<hour_number>

# Monitor all Redis commands in real time
MONITOR
```

---

## 📈 Production Scaling

### Horizontal Scaling Pattern

```yaml
# Add more API instances in docker-compose.yml
# and add them to nginx.conf upstream block

# docker-compose.yml
  api3:
    build: .
    environment: *api_environment  # YAML anchor reuse
    depends_on: [redis]
    networks: [rate-limiter-network]

# nginx.conf
upstream api_backend {
    least_conn;
    server api1:3000;
    server api2:3000;
    server api3:3000;   # Add this
}
```

### Redis High Availability (Production)

For production, replace single Redis with:

```
Redis Sentinel (HA):      Redis Cluster (scale):
   ┌──────────┐              Shard 1: slots 0–5460
   │ Primary  │              Shard 2: slots 5461–10922
   └────┬─────┘              Shard 3: slots 10923–16383
        │
   ┌────┴─────┐
   │ Replica  │
   └──────────┘
   + 3 Sentinels
```

### Kubernetes (Beyond Docker Compose)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rate-limiter-api
spec:
  replicas: 5          # 5 API pods, all sharing one Redis
  template:
    spec:
      containers:
      - name: api
        image: rate-limiter:latest
        env:
        - name: REDIS_URL
          value: redis://redis-service:6379
```

---

## 💡 Concepts Explained

### Why Redis is Ideal for Distributed Rate Limiting

1. **Single-threaded = atomic** — Redis processes one command at a time. No two requests can modify the same counter simultaneously. Combined with Lua scripts, the INCR+CHECK becomes an indivisible operation.

2. **Sub-millisecond latency** — Redis operations typically complete in <1ms, adding negligible overhead to each API request.

3. **Built-in TTL** — `EXPIRE` makes Redis automatically reset rate limit windows. No cron jobs, no cleanup code.

4. **Shared state** — 10 API instances all connect to 1 Redis. A user hitting api1 5 times and api2 5 times correctly gets blocked (total = 10), not allowed (each instance thinks they've only done 5).

5. **Lua scripting** — `redis.call()` inside Lua runs atomically. Our sliding window script does ZREMRANGEBYSCORE + ZCARD + ZADD in one atomic operation.

### How Docker Containers Communicate

Docker Compose creates a **virtual network** (a Linux bridge network). Each container gets:
- A hostname equal to its service name (`redis`, `api1`, `nginx`)
- An IP on the private subnet (e.g., `172.20.0.x`)
- DNS resolution via Docker's embedded DNS server

When `api1` connects to `redis://redis:6379`, Docker resolves `redis` to `172.20.0.2` (or wherever Redis landed). No hardcoded IPs. Containers outside this network cannot reach these services.

### Fixed Window vs. Sliding Window

| | Fixed Window | Sliding Window |
|---|---|---|
| **Memory** | O(1) — just a counter | O(n) — stores timestamps |
| **Fairness** | Boundary burst possible | Perfectly fair |
| **Complexity** | Simple | Moderate |
| **Best for** | High-volume, approximate limiting | Precise, fair APIs |

**Boundary burst example:**  
Limit: 10 req/min, window: 00:00–01:00

- Fixed: User sends 10 at 00:59, 10 at 01:01 → **20 requests in 2 seconds** ✗
- Sliding: At 01:01, the 00:59 requests are still in the last-60s window → blocked ✓

### How This Architecture Scales in Production

```
Current (dev):    Nginx → [api1, api2] → Redis
                  Handles: ~2,000 req/s

Production v1:    Load Balancer → [api1..api10] → Redis Sentinel
                  Handles: ~10,000 req/s

Production v2:    CDN → Load Balancer → [api1..api50]
                                      → Redis Cluster (3 shards)
                  Handles: ~100,000+ req/s

Key insight: API layer scales horizontally (just add containers).
             Redis scales via Cluster sharding (partition by key hash).
             Nginx/Load Balancer scales via anycast DNS or cloud LB.
```

---

## 📁 Project Structure

```
distributed-rate-limiter/
├── src/
│   ├── config/
│   │   ├── redis.js          # Redis client singleton
│   │   └── rateLimiter.js    # Rate limit config from env vars
│   ├── middleware/
│   │   ├── rateLimiter.js    # Express rate limit middleware
│   │   ├── requestLogger.js  # Request/response logging
│   │   └── errorHandler.js   # Centralized error handling
│   ├── routes/
│   │   └── api.js            # All route definitions
│   ├── services/
│   │   └── rateLimiterService.js  # Core Redis algorithms
│   ├── utils/
│   │   ├── logger.js         # Winston logger
│   │   └── response.js       # Standardized response helpers
│   ├── app.js                # Express app factory
│   └── server.js             # Entry point + graceful shutdown
├── nginx/
│   └── nginx.conf            # Nginx load balancer config
├── Dockerfile                # Multi-stage production build
├── docker-compose.yml        # Full stack orchestration
├── .env                      # Environment variables
├── .dockerignore
├── .gitignore
├── package.json
└── README.md
```

---

## 📄 License

MIT — use freely, attribution appreciated.

---

*Built with ❤️ using Node.js, Redis, and Docker*
