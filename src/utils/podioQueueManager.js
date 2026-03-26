const Bottleneck = require("bottleneck");
const WebhookState = require("../db/webhook-state.model");
const PodioItem = require("../db/podio-item.model");
const podioClient = require("../webhooks/client");
const transformPodioItem = require("./transformPodioItem");
const logger = require("../config/logger");

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 500;
const FLUSH_INTERVAL = parseInt(process.env.FLUSH_INTERVAL_MS) || 120_000;
const HEARTBEAT_INTERVAL = 10 * 60 * 1000;
const MAX_RETRIES = 3;

class PodioQueueManager {
  constructor() {
    if (PodioQueueManager.instance) return PodioQueueManager.instance;

    // Map<appId, Set<itemId>> — Set for O(1) dedup
    this.appMap = new Map();

    // Bottleneck governs flush calls — respects 250/hr filter limit
    // 14.4s between calls = ~4/min = ~240/hr (10 call buffer under limit)
    this.limiter = new Bottleneck({
      minTime: FLUSH_INTERVAL,
      maxConcurrent: 1,
    });

    this._startFlushLoop();
    this._startHeartbeat();

    PodioQueueManager.instance = this;
    return this;
  }

  /**
   * Add an item to the pending set for its app.
   * Set dedup means enqueueing the same item 100 times = stored once.
   */
  enqueue(appId, itemId) {
    const key = String(appId);
    if (!this.appMap.has(key)) this.appMap.set(key, new Set());
    this.appMap.get(key).add(String(itemId));
    logger.debug(`[Queue] Enqueued item ${itemId} for app ${appId}`);
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
        state.pendingItems.forEach((i) => {
          this.appMap.get(key).add(String(i.itemId));
          recovered++;
        });
      }
      logger.info(`[Queue] Recovered ${recovered} pending items from DB`);
    } catch (err) {
      logger.error("[Queue] Recovery failed:", err.message);
    }
  }

  /**
   * Every FLUSH_INTERVAL ms, schedule a flush for each app that has pending items.
   * The Bottleneck limiter serialises these so we never burst beyond rate limits.
   */
  _startFlushLoop() {
    setInterval(() => {
      for (const [appId, itemSet] of this.appMap) {
        if (itemSet.size === 0) continue;
        this.limiter.schedule(() => this._flushApp(appId));
      }
    }, FLUSH_INTERVAL);
  }

  /**
   * Drain all pending items for one app, in batches of BATCH_SIZE.
   * Snapshot + clear pattern: new webhooks arriving during flush go into the next cycle.
   */
  async _flushApp(appId) {
    const itemSet = this.appMap.get(appId);
    if (!itemSet || itemSet.size === 0) return;

    const itemIds = [...itemSet];
    itemSet.clear();

    logger.info(`[Queue] Flushing ${itemIds.length} items for app ${appId}`);

    for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
      const batch = itemIds.slice(i, i + BATCH_SIZE);
      await this._fetchBatch(appId, batch);
    }
  }

  /**
   * Fetch a batch of items using the filter API.
   * POST /item/app/{app_id}/filter/ — "Rate limited" (250/hr) per Podio docs.
   * On transient failure (5xx/network): re-enqueues with retry count.
   * On permanent failure (4xx): logs and drops — retrying won't help.
   */
  async _fetchBatch(appId, itemIds, retryCount = 0) {
    try {
      const { data } = await podioClient.post(`/item/app/${appId}/filter/`, {
        filters: { item_id: itemIds.map(Number) },
        limit: BATCH_SIZE,
        sort_by: "last_edit_on",
        sort_desc: true,
      });

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
        `[Queue] Batch fetch failed for app ${appId} | status=${status || "N/A"} | retry=${retryCount}/${MAX_RETRIES} | error=${err.message}`,
      );
      if (responseData) {
        logger.error(`[Queue] Podio response: ${JSON.stringify(responseData)}`);
      }

      // 4xx = permanent error (bad request, auth, not found) — don't retry
      if (status && status >= 400 && status < 500) {
        logger.error(
          `[Queue] Permanent ${status} error for app ${appId}. Dropping ${itemIds.length} items.`,
        );
        return;
      }

      // 5xx or network error — retry up to MAX_RETRIES
      if (retryCount < MAX_RETRIES) {
        logger.warn(
          `[Queue] Transient error. Re-enqueuing ${itemIds.length} items for app ${appId} (attempt ${retryCount + 1}/${MAX_RETRIES})`,
        );
        itemIds.forEach((id) => this.enqueue(appId, id));
      } else {
        logger.error(
          `[Queue] Max retries reached for app ${appId}. Dropping ${itemIds.length} items.`,
        );
      }
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
          filter: { item_id: transformed.item_id, app_id: transformed.app_id },
          update: {
            $set: {
              ...transformed,
              sync_status: "success",
              last_synced_at: new Date(),
              sync_error: null,
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
   * Persist current queue state to MongoDB.
   * Called by heartbeat timer and on graceful shutdown.
   */
  async persistState() {
    logger.info("[Queue] Persisting queue state to DB...");
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
      logger.info("[Queue] State persisted.");
    } catch (err) {
      logger.error("[Queue] Failed to persist state:", err.message);
    }
  }

  /**
   * Saves remaining (unprocessed) items to MongoDB every 10 minutes.
   * On server restart, init() loads this back — crash recovery mechanism.
   */
  _startHeartbeat() {
    setInterval(() => this.persistState(), HEARTBEAT_INTERVAL);
  }
}

const instance = new PodioQueueManager();
Object.freeze(instance);
module.exports = instance;
