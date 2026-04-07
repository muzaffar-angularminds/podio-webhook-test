const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const cors = require("cors");
const httpStatus = require("http-status");
const config = require("./config/config");
const morgan = require("./config/morgan");
const { authLimiter } = require("./middlewares/rateLimiter");
const route = require("./route");
const { errorConverter, errorHandler } = require("./middlewares/error");
const ApiError = require("./utils/apiError");
const mongoose = require("mongoose");
const { redis } = require("./config/redis");

// Bull Board
const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { ExpressAdapter } = require("@bull-board/express");
const { flushQueue, batchQueue, appQueue, seedQueue } = require("./queues");

const app = express();

// Bull Board UI at /debug/queues
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/debug/queues");
createBullBoard({
  queues: [
    new BullMQAdapter(flushQueue),
    new BullMQAdapter(batchQueue),
    new BullMQAdapter(appQueue),
    new BullMQAdapter(seedQueue),
  ],
  serverAdapter,
});
app.use("/debug/queues", serverAdapter.getRouter());

if (config.NODE_ENV !== "test") {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

app.use(helmet());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  compression({
    filter: (req, res) => {
      if (req.url.startsWith("/threads")) return false;
      return compression.filter(req, res);
    },
  }),
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (config.NODE_ENV === "production") return callback(null, true);
      if (config.NODE_ENV === "development") {
        const localhostRegex = /^https?:\/\/localhost(:\d+)?$/;
        const localNetworkRegex = /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/;
        if (localhostRegex.test(origin) || localNetworkRegex.test(origin))
          return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  }),
);

if (config.NODE_ENV === "production") {
  app.use("/auth", authLimiter);
}

// Empty favicon to prevent 404 errors
app.get("/favicon.ico", (req, res) => res.status(204).end());

// Define routes index in separate file.
app.use("/", route);

// Health check — verifies MongoDB and Redis connectivity
app.get("/status", async (req, res) => {
  const health = {
    status: "ok",
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    redis: redis.status === "ready" ? "connected" : redis.status,
  };

  if (health.mongo !== "connected" || health.redis !== "connected") {
    health.status = "degraded";
    return res.status(503).json(health);
  }

  res.json(health);
});

app.use((req, res, next) => {
  next(new ApiError(httpStatus.NOT_FOUND, "Not found"));
});

app.use(errorConverter);
app.use(errorHandler);

module.exports = app;
