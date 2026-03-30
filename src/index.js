const mongoose = require("mongoose");
const app = require("./app");
const config = require("./config/config");
const logger = require("./config/logger");
const { redis } = require("./config/redis");
const queueManager = require("./utils/podioQueueManager");
const { cleanupStaleReseeds } = require("./queues/secondaryWorker");

let server;
logger.info(`Node Environment => ${config.NODE_ENV}`);

// Connect to MongoDB and Redis, then start
mongoose.connect(config.MONGODB_URL).then(async () => {
  logger.info(`Connected to MongoDB => ${config.MONGODB_URL}`);

  // Check for stale reseeds from previous crashes
  await cleanupStaleReseeds();

  // Recover any pending queue items from DB
  await queueManager.init();

  // Start BullMQ workers (flush + batch + secondary)
  queueManager.startWorkers();

  server = app.listen(config.PORT, () => {
    logger.info(`Node server listening on port => ${config.PORT}`);
    logger.info(
      `Bull Board UI => http://localhost:${config.PORT}/admin/queues`,
    );
    logger.info(
      `App Registry => http://localhost:${config.PORT}/admin/apps`,
    );
  });
});

// Graceful shutdown: close workers → close server → disconnect Redis + MongoDB → exit
let isShuttingDown = false;
const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`${signal} received. Starting graceful shutdown...`);

  // Close BullMQ workers and persist staging Map
  await queueManager.shutdown();

  if (server) {
    server.close(async () => {
      try {
        await redis.quit();
        logger.info("Disconnected from Redis");
        await mongoose.disconnect();
        logger.info("Disconnected from MongoDB");
      } catch (err) {
        logger.error("Error during disconnect:", err.message);
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
