const mongoose = require("mongoose");
const app = require("./app");
const config = require("./config/config");
const logger = require("./config/logger");
const queueManager = require("./utils/podioQueueManager");

let server;
logger.info(`Node Environment => ${config.NODE_ENV}`);

// Connect to MongoDB using mongoose
mongoose.connect(config.MONGODB_URL).then(async () => {
  logger.info(`Connected to MongoDB => ${config.MONGODB_URL}`);

  // Recover any pending queue items from DB
  await queueManager.init();

  server = app.listen(config.PORT, () => {
    logger.info(`Node server listening on port => ${config.PORT}`);
  });
});

// Graceful shutdown: persist queue state → close server → disconnect DB → exit
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  // Persist any pending queue items before shutting down
  await queueManager.persistState();

  if (server) {
    server.close(async () => {
      try {
        await mongoose.disconnect();
        logger.info("Disconnected from MongoDB");
      } catch (err) {
        logger.error("Error disconnecting from MongoDB", err);
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
