const catchAsync = require("../utils/catchAsync");
const { verifyWebhook } = require("./service");
const queueManager = require("../utils/podioQueueManager");
const PodioItem = require("../db/podio-item.model");
const logger = require("../config/logger");

const handleWebhook = catchAsync(async (req, res) => {
  res.status(200).send();
  const app_id = req.params.appId;
  const { type, hook_id, code, item_id } = req.body;

  // All processing after 200 is fire-and-forget — errors must not crash Express
  try {
    switch (type) {
      case "hook.verify": {
        verifyWebhook({ hookId: hook_id, code });
        break;
      }

      case "item.create":
      case "item.update": {
        // No idempotency check — the staging Map's Set handles dedup.
        // Same item enqueued 100 times = stored once in the Set.
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
    }
  } catch (err) {
    logger.error(`[Webhook] Post-ACK processing error: ${err.message}`);
  }
});

module.exports = { handleWebhook };
