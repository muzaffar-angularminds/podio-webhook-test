const axios = require("axios");
const auth = require("../config/auth");
const logger = require("../config/logger");

const podioClient = axios.create({
  baseURL: "https://api.podio.com",
  timeout: 15_000,
  headers: { "Content-Type": "application/json" },
});

// Inject fresh token before every call
podioClient.interceptors.request.use(async (config) => {
  const token = await auth.getAccessToken();
  config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Log rate limit headers on every response
podioClient.interceptors.response.use(
  (response) => {
    const limit = response.headers["x-rate-limit-limit"];
    const remaining = response.headers["x-rate-limit-remaining"];
    if (remaining !== undefined) {
      logger.debug(`[RateLimit] ${remaining}/${limit} calls remaining`);
      if (Number(remaining) < Number(limit) * 0.2) {
        logger.warn(`[RateLimit] WARNING: Only ${remaining} calls left!`);
      }
    }
    return response;
  },
  (error) => {
    if (error.response?.status === 420) {
      logger.error("[RateLimit] 420 Enhance Your Calm — rate limit hit!");
    }
    return Promise.reject(error);
  },
);

module.exports = podioClient;
