const podioClient = require("./client");
const logger = require("../config/logger");

/**
 * Verify a Podio webhook hook
 * @param {Object} params
 * @param {String} params.hookId - Podio hook id
 * @param {String} params.code - Verification code
 */
const verifyWebhook = async ({ hookId, code }) => {
  try {
    await podioClient.post(`/hook/${hookId}/verify/validate`, { code });
    logger.info(`[Webhook] Hook ${hookId} verified successfully.`);
  } catch (error) {
    logger.error(
      `[Webhook] Verification failed hook_id=${hookId}: ${error.message}`,
      error,
    );
  }
};

module.exports = { verifyWebhook };
