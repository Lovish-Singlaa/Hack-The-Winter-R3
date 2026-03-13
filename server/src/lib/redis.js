/**
 * Redis client using ioredis
 * In production, connect to Redis cluster (Elasticache, Upstash, etc.)
 * For local dev, use Docker: docker run -p 6379:6379 redis
 */

import Redis from "ioredis";

let redisHost = process.env.REDIS_HOST || "127.0.0.1";
let redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);

// Fix if the user accidentally put the port inside REDIS_HOST like "123.45.67.89:6379"
if (redisHost.includes(":") && !redisHost.startsWith("http")) {
  const parts = redisHost.split(":");
  redisHost = parts[0];
  redisPort = parseInt(parts[1], 10);
}

const redis = new Redis({
  host: redisHost,
  port: redisPort,
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === "true" ? {} : undefined,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  lazyConnect: true,
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err);
});

// Lazy connect on first use with promise memoization to prevent race conditions
let connectionPromise = null;

async function ensureConnection() {
  if (redis.status === "ready") {
    return;
  }
  
  if (!connectionPromise) {
    connectionPromise = redis.connect().then(() => {
      console.log("✓ Redis connected");
    }).catch((err) => {
      console.error("✗ Redis connection failed:", err.message);
      connectionPromise = null;
      throw err;
    });
  }
  
  return connectionPromise;
}

export { redis, ensureConnection };
