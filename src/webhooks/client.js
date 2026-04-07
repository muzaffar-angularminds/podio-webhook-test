const axios = require("axios");
const auth = require("../config/auth");
const logger = require("../config/logger");
const apps = require("../config/apps");

const podioClient = axios.create({
  baseURL: "https://api.podio.com",
  timeout: 15_000,
  headers: { "Content-Type": "application/json" },
});

/**
 * Look up app credentials from the static config.
 */
const getAppCredentials = (appId) => {
  const app = apps.find((a) => a.appId === Number(appId));
  if (!app) throw new Error(`No app found for appId=${appId} in config/apps.js`);
  return { appId: app.appId, appToken: app.token };
};

// Inject fresh token before every call.
podioClient.interceptors.request.use(async (reqConfig) => {
  let appId, appToken;

  // Option 1: caller passes appAuth explicitly
  if (reqConfig.appAuth) {
    appId = reqConfig.appAuth.appId;
    appToken = reqConfig.appAuth.appToken;
    delete reqConfig.appAuth;
  }
  // Option 2: extract appId from URL and look up credentials
  else {
    const match = reqConfig.url?.match(/\/item\/app\/(\d+)\//);
    if (match) {
      const creds = getAppCredentials(match[1]);
      appId = creds.appId;
      appToken = creds.appToken;
    }
    // Option 3: hook verify / app schema calls — use first available app
    if (!appId && apps.length > 0) {
      appId = apps[0].appId;
      appToken = apps[0].token;
    }
  }

  if (appId && appToken) {
    const token = await auth.getAccessToken(appId, appToken);
    reqConfig.headers.Authorization = `Bearer ${token}`;
  }

  return reqConfig;
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
