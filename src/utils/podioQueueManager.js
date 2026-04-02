const { Worker, UnrecoverableError } = require("bullmq");
const WebhookState = require("../db/webhook-state.model");
const PodioItem = require("../db/podio-item.model");
const podioClient = require("../webhooks/client");
const transformPodioItem = require("./transformPodioItem");
const { flushQueue, batchQueue, createDuplicate } = require("../queues");
const { createSecondaryWorker } = require("../queues/secondaryWorker");
const logger = require("../config/logger");

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 500;
const FLUSH_DELAY = parseInt(process.env.FLUSH_DELAY_MS) || 120_000;
const HEARTBEAT_INTERVAL = 10 * 60 * 1000;

class PodioQueueManager {
  constructor() {
    if (PodioQueueManager.instance) return PodioQueueManager.instance;

    // Map<appId, Set<itemId>> — staging area, same as before
    this.appMap = new Map();
    this.flushWorker = null;
    this.batchWorker = null;
    this.secondaryWorker = null;
    this.heartbeatTimer = null;
    this._persistInFlight = null;

    PodioQueueManager.instance = this;
    return this;
  }

  /**
   * Add an item to the pending set for its app.
   * Then schedule a delayed BullMQ flush trigger for that app.
   * BullMQ dedup via jobId: only one flush trigger per app at a time.
   */
  async enqueue(appId, itemId) {
    const key = String(appId);
    if (!this.appMap.has(key)) this.appMap.set(key, new Set());
    this.appMap.get(key).add(Number(itemId));
    logger.debug(`[Queue] Enqueued item ${itemId} for app ${appId}`);

    await this._scheduleFlush(key);
  }

  /**
   * Schedule a delayed flush trigger for an app.
   * Uses a unique jobId per scheduling so BullMQ doesn't skip it
   * due to a completed/failed job with the same ID from a previous run.
   */
  async _scheduleFlush(appId) {
    const jobId = `flush-${appId}-${Date.now()}`;
    // Remove any existing delayed flush for this app before adding a new one
    const delayed = await flushQueue.getDelayed();
    for (const job of delayed) {
      if (job.data.appId === appId) {
        await job.remove();
      }
    }
    await flushQueue.add("flush", { appId }, { jobId, delay: FLUSH_DELAY });
    logger.debug(
      `[Queue] Flush scheduled for app ${appId} in ${FLUSH_DELAY}ms`,
    );
  }

  /**
   * Start BullMQ workers. Called after MongoDB is connected.
   */
  startWorkers() {
    this._startFlushWorker();
    this._startBatchWorker();
    this.secondaryWorker = createSecondaryWorker();
    this._startHeartbeat();
    logger.info("[Queue] Workers started (flush + batch + secondary)");
  }

  /**
   * Load persisted state from MongoDB on server restart.
   * Re-enqueues any items that were pending when the server last stopped.
   */
  async init() {
    try {
      const states = await WebhookState.find({});
      let recovered = 0;
      for (const state of states) {
        const key = String(state.appId);
        if (!this.appMap.has(key)) this.appMap.set(key, new Set());
        for (const i of state.pendingItems) {
          this.appMap.get(key).add(Number(i.itemId));
          recovered++;
        }
        // Schedule flush for recovered items
        if (state.pendingItems.length > 0) {
          await this._scheduleFlush(key);
        }
      }
      logger.info(`[Queue] Recovered ${recovered} pending items from DB`);
    } catch (err) {
      logger.error(`[Queue] Recovery failed: ${err.message}`);
    }
  }

  /**
   * Flush worker — consumes flush triggers.
   * Snapshots the staging Map for the app, clears it, pushes batch jobs.
   */
  _startFlushWorker() {
    this.flushWorker = new Worker(
      "podio-flush",
      async (job) => {
        const { appId } = job.data;
        const itemSet = this.appMap.get(appId);
        if (!itemSet || itemSet.size === 0) return;

        // Snapshot + clear — new webhooks arriving during fetch go to next cycle
        const itemIds = [...itemSet];
        itemSet.clear();

        logger.info(
          `[Queue] Flushing ${itemIds.length} items for app ${appId}`,
        );

        // Push batch jobs (chunks of BATCH_SIZE)
        for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
          const batch = itemIds.slice(i, i + BATCH_SIZE);
          await batchQueue.add("batch-fetch", {
            appId,
            itemIds: batch,
          });
        }
      },
      { connection: createDuplicate(), concurrency: 1, lockDuration: 60_000 },
    );

    this.flushWorker.on("completed", (job) => {
      logger.info(`[Queue] Flush job completed for app ${job?.data?.appId}`);
    });

    this.flushWorker.on("failed", (job, err) => {
      logger.error(
        `[Queue] Flush job failed for ${job?.data?.appId}: ${err.message}`,
      );
    });
  }

  /**
   * Batch worker — fetches items from Podio filter API and upserts to MongoDB.
   * Rate limited to stay under Podio's 250/hr filter endpoint budget.
   */
  _startBatchWorker() {
    this.batchWorker = new Worker(
      "podio-batches",
      async (job) => {
        const { appId, itemIds } = job.data;
        await this._fetchBatch(appId, itemIds);
      },
      {
        connection: createDuplicate(),
        concurrency: 1,
        lockDuration: 120_000, // 2 min — Podio API calls can be slow
        limiter: { max: 240, duration: 3_600_000 }, // 240/hr, under 250/hr limit
      },
    );

    this.batchWorker.on("completed", (job) => {
      logger.info(`[Queue] Batch job completed for app ${job?.data?.appId}`);
    });

    this.batchWorker.on("failed", (job, err) => {
      logger.error(
        `[Queue] Batch job failed for app ${job?.data?.appId}: ${err.message}`,
      );
    });
  }

  /**
   * Fetch a batch of items using the filter API.
   * POST /item/app/{app_id}/filter/?hook=false
   * 4xx → UnrecoverableError (no retry). 5xx → normal throw (BullMQ retries).
   */
  async _fetchBatch(appId, itemIds) {
    try {
      const { data } = await podioClient.post(
        `/item/app/${appId}/filter/?hook=false`,
        {
          filters: { item_id: itemIds.map(Number) },
          limit: BATCH_SIZE,
          sort_by: "last_edit_on",
          sort_desc: true,
        },
      );

      logger.info(
        `[Queue] Fetched ${data.items?.length ?? 0}/${itemIds.length} items for app ${appId}`,
      );

      if (data.items?.length) {
        await this._upsertBatch(data.items, appId);
      }
    } catch (err) {
      const status = err.response?.status;
      const responseData = err.response?.data;

      logger.error(
        `[Queue] Batch fetch failed for app ${appId} | status=${status || "N/A"} | error=${err.message}`,
      );
      if (responseData) {
        logger.error(`[Queue] Podio response: ${JSON.stringify(responseData)}`);
      }

      // 4xx = permanent — skip retries
      if (status && status >= 400 && status < 500) {
        throw new UnrecoverableError(
          `Permanent ${status} from Podio for app ${appId}. Dropping ${itemIds.length} items.`,
        );
      }
      // 5xx/network = transient — BullMQ retries with exponential backoff
      throw err;
    }
  }

  /**
   * Bulk upsert all items from a batch response into MongoDB.
   * Uses bulkWrite for efficiency — one DB round-trip for N items.
   */
  async _upsertBatch(items, appId) {
    const ops = items.map((raw) => {
      const transformed = transformPodioItem({
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

    await PodioItem.bulkWrite(ops, { ordered: false });
    logger.info(`[Queue] Upserted ${ops.length} items to MongoDB`);
  }

  /**
   * Persist current staging Map state to MongoDB.
   * Called by heartbeat timer and on graceful shutdown.
   */
  async persistState() {
    logger.debug("[Queue] Persisting queue state to DB...");
    try {
      for (const [appId, itemSet] of this.appMap) {
        const pendingItems = [...itemSet].map((itemId) => ({
          itemId,
          createdAt: new Date(),
        }));
        await WebhookState.findOneAndUpdate(
          { appId },
          { pendingItems, lastSyncAt: new Date() },
          { upsert: true, returnDocument: "after" },
        );
      }
      logger.debug("[Queue] State persisted.");
    } catch (err) {
      logger.error("[Queue] Failed to persist state:", err.message);
    }
  }

  /**
   * Heartbeat — persist staging Map every 10 minutes as fallback.
   * BullMQ handles primary durability via Redis, this is belt-and-suspenders.
   */
  _startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this._persistInFlight = this.persistState().finally(() => {
        this._persistInFlight = null;
      });
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Graceful shutdown — close workers, persist state, clear heartbeat.
   */
  async shutdown() {
    logger.info("[Queue] Shutting down workers...");
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // Wait for any in-flight heartbeat persist to finish
    if (this._persistInFlight) {
      logger.info("[Queue] Waiting for in-flight persist to complete...");
      await this._persistInFlight;
    }
    if (this.flushWorker) await this.flushWorker.close();
    if (this.batchWorker) await this.batchWorker.close();
    if (this.secondaryWorker) await this.secondaryWorker.close();
    await this.persistState();
    logger.info("[Queue] Workers closed and state persisted.");
  }
}

const instance = new PodioQueueManager();
module.exports = instance;
