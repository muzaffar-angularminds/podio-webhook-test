const State = require("../models/state.model");
const { flushQueue } = require("./index");
const { createFlushWorker, createBatchWorker } = require("./primaryWorker");
const { createSecondaryWorker } = require("./secondaryWorker");
const config = require("../config/config");
const logger = require("../config/logger");

class QueueManager {
  constructor() {
    if (QueueManager.instance) return QueueManager.instance;

    this.appMap = new Map();
    this.flushWorker = null;
    this.batchWorker = null;
    this.secondaryWorker = null;
    this.heartbeatTimer = null;
    this._persistInFlight = null;

    QueueManager.instance = this;
    return this;
  }

  /**
   * Add an item to the pending set for its app.
   * Then schedule a delayed BullMQ flush trigger.
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
   * Removes existing delayed flush to reset the timer.
   */
  async _scheduleFlush(appId) {
    const jobId = `flush-${appId}-${Date.now()}`;
    const delayed = await flushQueue.getDelayed();
    for (const job of delayed) {
      if (job.data.appId === appId) {
        await job.remove();
      }
    }
    await flushQueue.add(
      "flush",
      { appId },
      { jobId, delay: config.FLUSH_DELAY_MS || 120000 },
    );
    logger.debug(
      `[Queue] Flush scheduled for app ${appId} in ${config.FLUSH_DELAY_MS}ms`,
    );
  }

  /**
   * Start all BullMQ workers. Called after MongoDB is connected.
   */
  startWorkers() {
    this.flushWorker = createFlushWorker(this.appMap);
    this.batchWorker = createBatchWorker();
    this.secondaryWorker = createSecondaryWorker();
    this._startHeartbeat();
    logger.info("[Queue] Workers started (flush + batch + secondary)");
  }

  /**
   * Load persisted state from MongoDB on server restart.
   */
  async init() {
    try {
      const states = await State.find({});
      let recovered = 0;
      for (const state of states) {
        const key = String(state.appId);
        if (!this.appMap.has(key)) this.appMap.set(key, new Set());
        for (const i of state.pendingItems) {
          this.appMap.get(key).add(Number(i.itemId));
          recovered++;
        }
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
   * Persist current staging Map state to MongoDB.
   */
  async persistState() {
    logger.debug("[Queue] Persisting queue state to DB...");
    try {
      for (const [appId, itemSet] of this.appMap) {
        const pendingItems = [...itemSet].map((itemId) => ({
          itemId,
          createdAt: new Date(),
        }));
        await State.findOneAndUpdate(
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
   * Heartbeat — persist staging Map periodically as fallback.
   */
  _startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this._persistInFlight = this.persistState().finally(() => {
        this._persistInFlight = null;
      });
    }, config.HEARTBEAT_INTERVAL_MS || 3600000);
  }

  /**
   * Graceful shutdown — close all workers, persist state.
   */
  async shutdown() {
    logger.info("[Queue] Shutting down workers...");
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
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

const instance = new QueueManager();
module.exports = instance;
