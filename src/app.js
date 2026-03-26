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

const app = express();

if (config.NODE_ENV !== "test") {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

// Set necessary HTTP headers for app security
app.use(helmet());

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
    // Allow requests from configured allowed domains
    // Also allow non-browser clients that do not set an Origin header (e.g. curl, Postman).
    origin: (origin, callback) => {
      // No origin (server-to-server, curl) -> allow
      if (!origin) return callback(null, true);

      // Check if origin matches any allowed domain
      if (config.NODE_ENV === "production") return callback(null, true);

      // In development, allow localhost with any port and 192.168.x.x IPs
      if (config.NODE_ENV === "development") {
        const localhostRegex = /^https?:\/\/localhost(:\d+)?$/;
        const localNetworkRegex = /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/;
        if (localhostRegex.test(origin) || localNetworkRegex.test(origin))
          return callback(null, true);
      }

      // Otherwise reject
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true, // Necessary for cookies
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

// Define routes index in separate file.
app.use("/", route);

// Server status route
app.get("/status", (req, res) => res.sendStatus(200));

// Send back a 404 error for any unknown api request
app.use((req, res, next) => {
  next(new ApiError(httpStatus.NOT_FOUND, "Not found"));
});

// Convert error to ApiError, if request was rejected or it throws an error
app.use(errorConverter);

// Handle the error
app.use(errorHandler);

module.exports = app;
