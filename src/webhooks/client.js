const axios = require("axios");
const auth = require("../config/auth");
const logger = require("../config/logger");
const PodioApp = require("../db/podio-app.model");

const podioClient = axios.create({
  baseURL: "https://api.podio.com",
  timeout: 15_000,
  headers: { "Content-Type": "application/json" },
});

// App credential cache to avoid DB lookups on every request
const appCredentialCache = new Map();

/**
 * Look up app credentials from cache or DB.
 */
const getAppCredentials = async (appId) => {
  const key = String(appId);
  if (appCredentialCache.has(key)) return appCredentialCache.get(key);

  const app = await PodioApp.findOne({ appId: Number(appId), isActive: true });
  if (!app) throw new Error(`No active app found for appId=${appId}`);

  const creds = { appId: app.appId, appToken: app.appToken };
  appCredentialCache.set(key, creds);
  return creds;
};

/**
 * Clear cached credentials for an app (call when app is updated/deleted).
 */
const clearAppCredentialCache = (appId) => {
  appCredentialCache.delete(String(appId));
};

// Inject fresh token before every call.
// Reads appId from the URL path (/item/app/{appId}/...) or from config.appAuth.
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
      const creds = await getAppCredentials(match[1]);
      appId = creds.appId;
      appToken = creds.appToken;
    }
    // Option 3: hook verify calls — extract from URL pattern /hook/{id}/verify
    // These don't need app-specific auth, use any available app
    if (!appId) {
      const apps = await PodioApp.findOne({ isActive: true });
      if (apps) {
        appId = apps.appId;
        appToken = apps.appToken;
      }
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
module.exports.clearAppCredentialCache = clearAppCredentialCache;
