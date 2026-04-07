const Redis = require("ioredis");
const config = require("./config");
const logger = require("./logger");

let redisErrorLogged = false;

const redisOptions = {
  maxRetriesPerRequest: null, // required by BullMQ
  retryStrategy(times) {
    const delay = Math.min(times * 2000, 30000);
    return delay;
  },
};

const redis = new Redis(config.REDIS_URL, redisOptions);

redis.on("connect", () => {
  if (redisErrorLogged) {
    logger.info("[Redis] Reconnected");
  } else {
    logger.info("[Redis] Connected");
  }
  redisErrorLogged = false;
});
redis.on("error", (err) => {
  if (!redisErrorLogged) {
    logger.error(`[Redis] Connection failed: ${err.message}. Will keep retrying...`);
    redisErrorLogged = true;
  }
});

/**
 * Create a duplicate Redis connection that shares our config.
 * Errors are silently absorbed — the main connection handles logging.
 */
const createDuplicate = () => {
  const dup = redis.duplicate();
  dup.on("error", () => {}); // suppress — main connection logs errors
  return dup;
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

module.exports = { redis, createDuplicate, acquireLock, releaseLock };
