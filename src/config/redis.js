const Redis = require("ioredis");
const config = require("./config");
const logger = require("./logger");

const redis = new Redis(config.REDIS_URL);

redis.on("connect", () => logger.info("[Redis] Connected"));
redis.on("error", (err) => logger.error("[Redis] Error:", err.message));

/**
 * Check if a webhook event was already processed (idempotency).
 * @returns {boolean} true if already processed
 */
const checkIdempotency = async (key) => {
  const exists = await redis.get(key);
  return !!exists;
};

/**
 * Mark a webhook event as processed.
 * @param {string} key
 * @param {number} ttl - TTL in seconds (default 24hrs)
 */
const markProcessed = async (key, ttl = 86400) => {
  await redis.set(key, "1", "EX", ttl);
};

/**
 * Acquire a distributed lock. Returns true if acquired, false if already held.
 * @param {string} lockKey
 * @param {number} ttlSeconds - lock auto-expires after this many seconds
 */
const acquireLock = async (lockKey, ttlSeconds = 7200) => {
  const result = await redis.set(lockKey, Date.now().toString(), "EX", ttlSeconds, "NX");
  return result === "OK";
};

/**
 * Release a distributed lock.
 * @param {string} lockKey
 */
const releaseLock = async (lockKey) => {
  await redis.del(lockKey);
};

module.exports = { redis, checkIdempotency, markProcessed, acquireLock, releaseLock };
