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
const cookieParser = require("cookie-parser");
const ApiError = require("./utils/apiError");

// Bull Board
const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { ExpressAdapter } = require("@bull-board/express");
const { flushQueue, batchQueue, appQueue, seedQueue } = require("./queues");

const app = express();

// Bull Board UI at /admin/queues
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");
createBullBoard({
  queues: [
    new BullMQAdapter(flushQueue),
    new BullMQAdapter(batchQueue),
    new BullMQAdapter(appQueue),
    new BullMQAdapter(seedQueue),
  ],
  serverAdapter,
});
app.use("/admin/queues", serverAdapter.getRouter());

if (config.NODE_ENV !== "test") {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

// Set necessary HTTP headers for app security
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
      },
    },
  }),
);

// JSON requests are received as plain text. We need to parse the json request body.
app.use(express.json());

// Parse urlencoded request body if provided with any of the requests
app.use(express.urlencoded({ extended: true }));

// Using gzip compression for faster transfer of response data
app.use(
  compression({
    filter: (req, res) => {
      // Disable compression for /stream
      if (req.url.startsWith("/threads")) return false;
      return compression.filter(req, res); // fallback to default
    },
  }),
);

// Enable cors to accept requests from any frontend domain, all possible HTTP methods, and necessary items in request headers
app.use(
  cors({
    origin: (origin, callback) => {
      // No origin (server-to-server, curl) -> allow
      if (!origin) return callback(null, true);

      if (config.NODE_ENV === "production") return callback(null, true);

      // In development, allow localhost with any port and 192.168.x.x IPs
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

// To accept cookies.
app.use(cookieParser());

// Limit repeated failed requests to auth endpoints
if (config.NODE_ENV === "production") {
  app.use("/auth", authLimiter);
}

// Empty favicon to prevent 404 errors
app.get("/favicon.ico", (req, res) => res.status(204).end());

// Define routes index in separate file.
app.use("/", route);

// Health check — verifies MongoDB and Redis connectivity
app.get("/status", async (req, res) => {
  const mongoose = require("mongoose");
  const { redis } = require("./config/redis");

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

// Send back a 404 error for any unknown api request
app.use((req, res, next) => {
  next(new ApiError(httpStatus.NOT_FOUND, "Not found"));
});

// Convert error to ApiError, if request was rejected or it throws an error
app.use(errorConverter);

// Handle the error
app.use(errorHandler);

module.exports = app;
