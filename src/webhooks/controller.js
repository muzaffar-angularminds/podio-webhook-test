const catchAsync = require("../utils/catchAsync");
const { verifyWebhook } = require("./service");
const queueManager = require("../utils/podioQueueManager");
const logger = require("../config/logger");

const handleWebhook = catchAsync(async (req, res) => {
  res.status(200).send();
  const app_id = req.params.appId;
  const { type, hook_id, code, item_id } = req.body;

  switch (type) {
    case "hook.verify": {
      verifyWebhook({ hookId: hook_id, code });
      break;
    }

    case "item.create": {
      queueManager.enqueue(app_id, item_id);
      logger.info(
        `[Webhook] item.create enqueued: app=${app_id} item=${item_id}`,
      );
      break;
    }

    case "item.update": {
      queueManager.enqueue(app_id, item_id);
      logger.info(
        `[Webhook] item.update enqueued: app=${app_id} item=${item_id}`,
      );
      break;
    }

    case "item.delete": {
      break;
    }
  }
});

module.exports = { handleWebhook };
