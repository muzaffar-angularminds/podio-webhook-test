const axios = require("axios");
const config = require("./config");
const logger = require("./logger");

/**
 * Multi-app Podio Auth Manager.
 * Maintains a token cache keyed by appId.
 * Each app authenticates independently using its own appToken
 * + shared clientId/clientSecret from env.
 */
class PodioAuthManager {
  constructor() {
    // Map<appId, { accessToken, refreshToken, expiresAt, appToken }>
    this.tokenCache = new Map();
  }

  /**
   * Returns a valid access token for the given app.
   * @param {string|number} appId
   * @param {string} appToken
   */
  async getAccessToken(appId, appToken) {
    const key = String(appId);
    const cached = this.tokenCache.get(key);

    // Store appToken in cache so refresh can fall back to re-auth
    if (appToken && cached && !cached.appToken) {
      cached.appToken = appToken;
    }

    if (cached && this._isValid(cached)) {
      return cached.accessToken;
    }

    if (cached?.refreshToken) {
      return this._refresh(key);
    }

    return this._authenticate(key, appToken);
  }

  _isValid(cached) {
    return cached.accessToken && Date.now() < cached.expiresAt - 60_000;
  }

  /**
   * Authenticate with Podio using app credentials.
   */
  async _authenticate(appId, appToken) {
    if (!appToken) {
      throw new Error(`[Auth] No appToken available for app ${appId}. Cannot authenticate.`);
    }
    logger.info(`[Auth] Authenticating app ${appId}...`);
    const { data } = await axios.post(
      "https://api.podio.com/oauth/token/v2",
      {
        grant_type: "app",
        app_id: appId,
        app_token: appToken,
        client_id: config.PODIO_CLIENT_ID,
        client_secret: config.PODIO_CLIENT_SECRET,
      },
      { headers: { "Content-Type": "application/json" } },
    );
    this._store(appId, data, appToken);
    logger.info(`[Auth] App ${appId} authenticated. Expires in ${data.expires_in}s`);
    return data.access_token;
  }

  /**
   * Refresh token for an app. Falls back to re-auth if refresh fails.
   */
  async _refresh(appId) {
    const cached = this.tokenCache.get(String(appId));
    logger.info(`[Auth] Refreshing token for app ${appId}...`);
    try {
      const { data } = await axios.post(
        "https://api.podio.com/oauth/token/v2",
        {
          grant_type: "refresh_token",
          refresh_token: cached.refreshToken,
          client_id: config.PODIO_CLIENT_ID,
          client_secret: config.PODIO_CLIENT_SECRET,
        },
        { headers: { "Content-Type": "application/json" } },
      );
      this._store(appId, data, cached.appToken);
      logger.info(`[Auth] App ${appId} token refreshed.`);
      return data.access_token;
    } catch (err) {
      logger.warn(`[Auth] Refresh failed for app ${appId}: ${err.message}. Re-authenticating...`);
      // Fall back to full re-auth using stored appToken
      if (cached?.appToken) {
        this.tokenCache.delete(String(appId));
        return this._authenticate(appId, cached.appToken);
      }
      this.tokenCache.delete(String(appId));
      throw new Error(`[Auth] Token refresh failed for app ${appId} and no appToken available for re-auth.`);
    }
  }

  _store(appId, data, appToken) {
    this.tokenCache.set(String(appId), {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      appToken: appToken || null,
    });
  }
}

module.exports = new PodioAuthManager();
