const { Worker, UnrecoverableError } = require("bullmq");
const AppItems = require("../models/app-items.model");
const podioClient = require("../webhooks/client");
const transformAppItem = require("../utils/transformAppItem");
const { batchQueue, createDuplicate } = require("./index");
const config = require("../config/config");
const logger = require("../config/logger");

/**
 * Create the flush worker.
 * Consumes flush triggers — snapshots the staging Map, clears it, pushes batch jobs.
 * @param {Map} appMap - Reference to the staging Map from queueManager
 */
function createFlushWorker(appMap) {
  const worker = new Worker(
    "podio-flush",
    async (job) => {
      const { appId } = job.data;
      const itemSet = appMap.get(appId);
      if (!itemSet || itemSet.size === 0) return;

      const itemIds = [...itemSet];
      itemSet.clear();

      logger.info(`[Flush] Flushing ${itemIds.length} items for app ${appId}`);

      for (let i = 0; i < itemIds.length; i += config.BATCH_SIZE) {
        const batch = itemIds.slice(i, i + config.BATCH_SIZE);
        await batchQueue.add("batch-fetch", { appId, itemIds: batch });
      }
    },
    { connection: createDuplicate(), concurrency: 1, lockDuration: 60_000 },
  );

  worker.on("completed", (job) => {
    logger.info(`[Flush] Job completed for app ${job?.data?.appId}`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`[Flush] Job failed for ${job?.data?.appId}: ${err.message}`);
  });

  return worker;
}

/**
 * Create the batch worker.
 * Fetches items from Podio filter API and upserts to MongoDB.
 * Rate limited to 240/hr (under Podio's 250/hr ceiling).
 */
function createBatchWorker() {
  const worker = new Worker(
    "podio-batches",
    async (job) => {
      const { appId, itemIds } = job.data;
      await fetchBatch(appId, itemIds);
    },
    {
      connection: createDuplicate(),
      concurrency: 1,
      lockDuration: 120_000,
      limiter: { max: 240, duration: 3_600_000 },
    },
  );

  worker.on("completed", (job) => {
    logger.info(`[Batch] Job completed for app ${job?.data?.appId}`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`[Batch] Job failed for app ${job?.data?.appId}: ${err.message}`);
  });

  return worker;
}

/**
 * Fetch a batch of items using the filter API.
 * POST /item/app/{app_id}/filter/?hook=false
 * 4xx → UnrecoverableError (no retry). 5xx → normal throw (BullMQ retries).
 */
async function fetchBatch(appId, itemIds) {
  try {
    const { data } = await podioClient.post(
      `/item/app/${appId}/filter/?hook=false`,
      {
        filters: { item_id: itemIds.map(Number) },
        limit: config.BATCH_SIZE,
        sort_by: "last_edit_on",
        sort_desc: true,
      },
    );

    logger.info(
      `[Batch] Fetched ${data.items?.length ?? 0}/${itemIds.length} items for app ${appId}`,
    );

    if (data.items?.length) {
      await upsertBatch(data.items, appId);
    }
  } catch (err) {
    const status = err.response?.status;
    const responseData = err.response?.data;

    logger.error(
      `[Batch] Fetch failed for app ${appId} | status=${status || "N/A"} | error=${err.message}`,
    );
    if (responseData) {
      logger.error(`[Batch] Podio response: ${JSON.stringify(responseData)}`);
    }

    if (status && status >= 400 && status < 500) {
      throw new UnrecoverableError(
        `Permanent ${status} from Podio for app ${appId}. Dropping ${itemIds.length} items.`,
      );
    }
    throw err;
  }
}

/**
 * Bulk upsert all items from a batch response into MongoDB.
 * Uses bulkWrite for efficiency — one DB round-trip for N items.
 */
async function upsertBatch(items, appId) {
  const ops = items.map((raw) => {
    const transformed = transformAppItem({
      ...raw,
      app_id: Number(raw.app_id) || Number(appId),
    });
    return {
      updateOne: {
        filter: { itemId: transformed.itemId, appId: transformed.appId },
        update: {
          $set: {
            ...transformed,
            syncStatus: "success",
            lastSyncedAt: new Date(),
            syncError: null,
          },
        },
        upsert: true,
      },
    };
  });

  await AppItems.bulkWrite(ops, { ordered: false });
  logger.info(`[Batch] Upserted ${ops.length} items to MongoDB`);
}

module.exports = { createFlushWorker, createBatchWorker };
