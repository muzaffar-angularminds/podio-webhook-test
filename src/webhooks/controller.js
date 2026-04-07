const catchAsync = require("../utils/catchAsync");
const { verifyWebhook } = require("./service");
const queueManager = require("../queues/queueManager");
const AppItems = require("../models/app-items.model");
const apps = require("../config/apps");
const { appQueue } = require("../queues");
const logger = require("../config/logger");

const isValidId = (id) => /^\d+$/.test(String(id));

// Build a Set of registered appIds from config for O(1) lookup
const registeredAppIds = new Set(apps.map((a) => a.appId));

function isAppRegistered(appId) {
  return registeredAppIds.has(Number(appId));
}

const handleWebhook = catchAsync(async (req, res) => {
  res.status(200).send();
  const app_id = req.params.appId;
  const { type, hook_id, code, item_id } = req.body;

  if (!isValidId(app_id)) {
    logger.warn(`[Webhook] Invalid appId: ${app_id}`);
    return;
  }

  try {
    switch (type) {
      case "hook.verify": {
        await verifyWebhook({ hookId: hook_id, code });
        break;
      }

      case "item.create":
      case "item.update": {
        if (!isAppRegistered(app_id)) {
          logger.warn(`[Webhook] ${type} for unregistered app ${app_id}, ignoring`);
          break;
        }
        await queueManager.enqueue(app_id, item_id);
        logger.info(
          `[Webhook] ${type} enqueued: app=${app_id} item=${item_id}`,
        );
        break;
      }

      case "item.delete": {
        await AppItems.delete({ itemId: Number(item_id), appId: Number(app_id) });
        logger.info(
          `[Webhook] item.delete soft-deleted: app=${app_id} item=${item_id}`,
        );
        break;
      }

      case "app.update": {
        await appQueue.add(
          "app-event",
          { type, appId: app_id },
          { jobId: `app-update-${app_id}-${Date.now()}` },
        );
        logger.info(`[Webhook] app.update enqueued: app=${app_id}`);
        break;
      }

      case "app.delete": {
        await appQueue.add(
          "app-event",
          { type, appId: app_id },
          { jobId: `app-delete-${app_id}-${Date.now()}` },
        );
        logger.info(`[Webhook] app.delete enqueued: app=${app_id}`);
        break;
      }

      default: {
        logger.warn(`[Webhook] Unhandled event type: ${type} | app=${app_id}`);
        break;
      }
    }
  } catch (err) {
    logger.error(`[Webhook] Post-ACK processing error: ${err.message}`);
  }
});

module.exports = { handleWebhook };
