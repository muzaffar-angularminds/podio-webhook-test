const axios = require("axios");
const config = require("./config");
const logger = require("./logger");

class PodioAuthManager {
  constructor() {
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = null;
  }

  /**
   * Returns a valid access token, refreshing if expired.
   */
  async getAccessToken() {
    if (this._isValid()) return this.accessToken;
    if (this.refreshToken) return this._refresh();
    return this._authenticate();
  }

  _isValid() {
    return this.accessToken && Date.now() < this.expiresAt - 60_000;
  }

  /**
   * Initial app authentication
   * POST /oauth/token/v2 with grant_type=app
   */
  async _authenticate() {
    logger.info("[Auth] Authenticating with Podio App credentials...");
    const { data } = await axios.post(
      "https://api.podio.com/oauth/token/v2",
      {
        grant_type: "app",
        app_id: config.PODIO_APP_ID,
        app_token: config.PODIO_APP_TOKEN,
        client_id: config.PODIO_CLIENT_ID,
        client_secret: config.PODIO_CLIENT_SECRET,
      },
      { headers: { "Content-Type": "application/json" } },
    );
    this._store(data);
    logger.info(`[Auth] Authenticated. Token expires in ${data.expires_in}s`);
    return this.accessToken;
  }

  /**
   * Refresh using refresh_token
   */
  async _refresh() {
    logger.info("[Auth] Refreshing Podio access token...");
    try {
      const { data } = await axios.post(
        "https://api.podio.com/oauth/token/v2",
        {
          grant_type: "refresh_token",
          refresh_token: this.refreshToken,
          client_id: config.PODIO_CLIENT_ID,
          client_secret: config.PODIO_CLIENT_SECRET,
        },
        { headers: { "Content-Type": "application/json" } },
      );
      this._store(data);
      logger.info("[Auth] Token refreshed successfully.");
      return this.accessToken;
    } catch (err) {
      logger.warn("[Auth] Refresh failed, re-authenticating...");
      this.refreshToken = null;
      return this._authenticate();
    }
  }

  _store(data) {
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
  }
}

module.exports = new PodioAuthManager();
