const mongoose = require("mongoose");
const app = require("./app");
const config = require("./config/config");
const logger = require("./config/logger");
const { redis } = require("./config/redis");
const queueManager = require("./queues/queueManager");
const { cleanupStaleReseeds } = require("./queues/secondaryWorker");

let server;
logger.info(`Node Environment => ${config.NODE_ENV}`);

// Connect to MongoDB with retry logic
const MAX_MONGO_RETRIES = 5;
async function connectWithRetry(attempt = 1) {
  try {
    await mongoose.connect(config.MONGODB_URL);
    logger.info(`Connected to MongoDB => ${config.MONGODB_URL}`);
  } catch (err) {
    if (attempt >= MAX_MONGO_RETRIES) {
      logger.error(`[MongoDB] Failed to connect after ${MAX_MONGO_RETRIES} attempts: ${err.message}`);
      process.exit(1);
    }
    const delay = Math.pow(2, attempt) * 1000;
    logger.warn(`[MongoDB] Connection attempt ${attempt} failed: ${err.message}. Retrying in ${delay / 1000}s...`);
    await new Promise((r) => setTimeout(r, delay));
    return connectWithRetry(attempt + 1);
  }
}

connectWithRetry().then(async () => {
  await cleanupStaleReseeds();
  await queueManager.init();
  queueManager.startWorkers();

  server = app.listen(config.PORT, () => {
    logger.info(`Node server listening on port => ${config.PORT}`);
    logger.info(`Bull Board UI => http://localhost:${config.PORT}/debug/queues`);
  });
}).catch((err) => {
  logger.error(`[Startup] Fatal error during initialization: ${err.message}`);
  process.exit(1);
});

// Graceful shutdown
let isShuttingDown = false;
const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`${signal} received. Starting graceful shutdown...`);

  try {
    await queueManager.shutdown();
  } catch (err) {
    logger.error(`[Shutdown] Queue shutdown error: ${err.message}`);
  }

  if (server) {
    server.close(async () => {
      try {
        await redis.quit();
        logger.info("Disconnected from Redis");
      } catch (err) {
        logger.error(`[Shutdown] Redis disconnect error: ${err.message}`);
      }
      try {
        await mongoose.disconnect();
        logger.info("Disconnected from MongoDB");
      } catch (err) {
        logger.error(`[Shutdown] MongoDB disconnect error: ${err.message}`);
      }
      logger.info("Server closed");
      process.exit(0);
    });
  } else {
    process.exit(1);
  }
};

const unexpectedErrorHandler = async (error) => {
  logger.error(error);
  await gracefulShutdown("UNEXPECTED_ERROR");
};

process.on("uncaughtException", unexpectedErrorHandler);
process.on("unhandledRejection", unexpectedErrorHandler);
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
