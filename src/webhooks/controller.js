const catchAsync = require("../utils/catchAsync");
const { verifyWebhook } = require("./service");
const queueManager = require("../utils/podioQueueManager");
const PodioItem = require("../db/podio-item.model");
const PodioApp = require("../db/podio-app.model");
const { appQueue } = require("../queues");
const logger = require("../config/logger");

const isValidId = (id) => /^\d+$/.test(String(id));

// Cache active appIds to avoid DB lookup on every webhook
const activeAppCache = new Set();
let cacheLoadedAt = 0;
const CACHE_TTL = 60_000; // 1 minute

async function isAppActive(appId) {
  // Refresh cache if stale
  if (Date.now() - cacheLoadedAt > CACHE_TTL) {
    const apps = await PodioApp.find({ isActive: true }, { appId: 1 });
    activeAppCache.clear();
    apps.forEach((a) => activeAppCache.add(a.appId));
    cacheLoadedAt = Date.now();
  }
  return activeAppCache.has(Number(appId));
}

const handleWebhook = catchAsync(async (req, res) => {
  res.status(200).send();
  const app_id = req.params.appId;
  const { type, hook_id, code, item_id } = req.body;

  if (!isValidId(app_id)) {
    logger.warn(`[Webhook] Invalid appId: ${app_id}`);
    return;
  }

  // All processing after 200 is fire-and-forget — errors must not crash Express
  try {
    switch (type) {
      case "hook.verify": {
        await verifyWebhook({ hookId: hook_id, code });
        break;
      }

      case "item.create":
      case "item.update": {
        if (!(await isAppActive(app_id))) {
          logger.warn(`[Webhook] ${type} for unregistered/inactive app ${app_id}, ignoring`);
          break;
        }
        await queueManager.enqueue(app_id, item_id);
        logger.info(
          `[Webhook] ${type} enqueued: app=${app_id} item=${item_id}`,
        );
        break;
      }

      case "item.delete": {
        await PodioItem.delete({ itemId: Number(item_id), appId: Number(app_id) });
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
