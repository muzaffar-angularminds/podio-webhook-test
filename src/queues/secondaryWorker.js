const { Worker, UnrecoverableError } = require("bullmq");
const crypto = require("crypto");
const mongoose = require("mongoose");
const AppSchema = require("../models/app-schema.model");
const AppSchemaLogs = require("../models/app-schema-logs.model");
const AppItems = require("../models/app-items.model");
const podioClient = require("../webhooks/client");
const transformAppItem = require("../utils/transformAppItem");
const diffSchemas = require("../utils/diffSchemas");
const config = require("../config/config");
const apps = require("../config/apps");
const logger = require("../config/logger");
const { acquireLock, releaseLock } = require("../config/redis");
const { createDuplicate } = require("./index");

const PAGE_MAX_RETRIES = 5;
const PAGE_RETRY_BASE_MS = 10_000;
const RATE_LIMIT_PAUSE_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch a single page from Podio with robust retry logic.
 * - 420 (rate limit): waits 60s then retries (does NOT count as an attempt)
 * - 5xx/network: exponential backoff (10s → 20s → 40s → 80s → 160s), max 5 attempts
 * - 4xx (except 420): permanent error, throws immediately
 */
/**
 * @param {object} options
 * @param {string} [options.dateFrom] - Filter: created_on >= date (YYYY-MM-DD)
 * @param {string} [options.dateTo] - Filter: created_on <= date (YYYY-MM-DD)
 * @param {number} [options.batchSize] - Override batch size
 */
async function fetchPageWithRetry(appId, offset, options = {}, attempt = 1) {
  const batchSize = options.batchSize || config.BATCH_SIZE;

  try {
    logger.debug(
      `[Reseed] Fetching page at offset ${offset} for app ${appId} (batch=${batchSize})...`,
    );
    const startTime = Date.now();

    // Build filters and sort
    const filters = {};
    const hasDateFilter = options.dateFrom || options.dateTo;

    if (hasDateFilter) {
      const dateRange = {};
      if (options.dateFrom) dateRange.from = `${options.dateFrom} 00:00:00`;
      if (options.dateTo) dateRange.to = `${options.dateTo} 23:59:59`;
      filters.created_on = dateRange;
    }

    const sortBy = hasDateFilter ? "created_on" : "item_id";

    const { data } = await podioClient.post(
      `/item/app/${appId}/filter/?hook=false`,
      {
        filters,
        limit: batchSize,
        offset,
        sort_by: sortBy,
        sort_desc: false,
      },
      { timeout: 300_000 },
    );
    logger.debug(
      `[Reseed] Page at offset ${offset} fetched in ${Date.now() - startTime}ms (${data.items?.length || 0} items)`,
    );
    return data;
  } catch (err) {
    const status = err.response?.status;

    // 420 = rate limited — wait and retry (doesn't count as an attempt)
    if (status === 420) {
      logger.warn(
        `[Reseed] Rate limited (420) at offset ${offset}. Pausing ${RATE_LIMIT_PAUSE_MS / 1000}s before retry...`,
      );
      await sleep(RATE_LIMIT_PAUSE_MS);
      return fetchPageWithRetry(appId, offset, options, attempt);
    }

    // 4xx (except 420) = permanent error, no point retrying
    if (status && status >= 400 && status < 500) {
      logger.error(
        `[Reseed] Permanent ${status} from Podio at offset ${offset}: ${err.message}`,
      );
      if (err.response?.data) {
        logger.error(
          `[Reseed] Podio response: ${JSON.stringify(err.response.data)}`,
        );
      }
      throw err;
    }

    // 5xx/network = transient — exponential backoff
    if (attempt <= PAGE_MAX_RETRIES) {
      const delay = PAGE_RETRY_BASE_MS * Math.pow(2, attempt - 1); // 10s, 20s, 40s, 80s, 160s
      logger.warn(
        `[Reseed] Page at offset ${offset} failed (attempt ${attempt}/${PAGE_MAX_RETRIES}): ${err.message}. Retrying in ${delay / 1000}s...`,
      );
      await sleep(delay);
      return fetchPageWithRetry(appId, offset, options, attempt + 1);
    }

    logger.error(
      `[Reseed] Page at offset ${offset} failed after ${PAGE_MAX_RETRIES} attempts. Giving up.`,
    );
    throw err;
  }
}

/**
 * Format seconds into human-readable duration.
 */
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Reseed an app using the shadow collection + atomic swap approach.
 *
 * Production-grade for 100K+ items:
 * - Checkpoint resume: round down to nearest BATCH_SIZE on resume
 * - 420 rate limit handling: pause 60s and retry
 * - Exponential backoff: 5 retries (10s → 20s → 40s → 80s → 160s)
 * - ETA logging: estimated time remaining per page
 * - Insert count verification: checks actual insertedCount
 * - Distributed lock via Redis
 */
/**
 * @param {string|number} appId
 * @param {object} [options]
 * @param {string} [options.dateFrom] - Filter: created_on >= date
 * @param {string} [options.dateTo] - Filter: created_on <= date
 * @param {number} [options.batchSize] - Override batch size
 */
async function reseedApp(appId, options = {}) {
  const appIdNum = Number(appId);
  const appConfig = apps.find((a) => a.appId === appIdNum);
  const appLabel = appConfig ? `${appConfig.name} (${appId})` : String(appId);
  const batchSize = options.batchSize || config.BATCH_SIZE;
  const lockKey = `reseed-lock-${appIdNum}`;
  const shadowName = `podio_items_staging_${appId}`;
  const shadowCollection = mongoose.connection.collection(shadowName);
  const swapStartTime = new Date();

  // Acquire lock — skip locking if Redis is unavailable (standalone seed script)
  let lockAcquired = false;
  try {
    lockAcquired = await acquireLock(lockKey, 14400); // 4 hours for large apps
    if (!lockAcquired) {
      logger.warn(
        `[Reseed] ${appLabel}: reseed already in progress (lock held). Skipping.`,
      );
      return;
    }
  } catch (lockErr) {
    logger.warn(
      `[Reseed] ${appLabel}: Redis unavailable for lock, proceeding without lock`,
    );
  }

  const existing = await AppSchema.findOne({ appId: appIdNum });
  let resumeOffset = 0;

  if (
    existing?.reseedStatus === "in_progress" &&
    existing?.reseedProgress?.current > 0
  ) {
    const shadowCount = await shadowCollection.countDocuments().catch(() => 0);
    if (shadowCount > 0) {
      // Round down to nearest BATCH_SIZE — partial page inserts may have occurred
      resumeOffset = Math.floor(shadowCount / batchSize) * batchSize;
      logger.info(
        `[Reseed] Resuming app ${appId} from offset ${resumeOffset} (${shadowCount} docs in shadow, rounded to page boundary)`,
      );
    }
  } else {
    try {
      await shadowCollection.drop();
    } catch (e) {
      // Collection doesn't exist, fine
    }
  }

  logger.info(
    `[Reseed] Starting reseed for app ${appId}${resumeOffset > 0 ? ` (resuming from ${resumeOffset})` : ""}${options.dateFrom || options.dateTo ? ` [date filter: ${options.dateFrom || "start"} → ${options.dateTo || "now"}]` : ""} (batch=${batchSize})`,
  );

  await AppSchema.findOneAndUpdate(
    { appId: appIdNum },
    {
      reseedStatus: "in_progress",
      reseedStartedAt:
        resumeOffset > 0 ? existing.reseedStartedAt : swapStartTime,
      reseedProgress: {
        current: resumeOffset,
        total: existing?.reseedProgress?.total || 0,
      },
      reseedError: null,
    },
    { upsert: true },
  );

  const fetchStartTime = Date.now();

  try {
    // ── Phase 1: Fetch all items into shadow collection ────────────────────
    let offset = resumeOffset;
    let total = null;
    let fetched = resumeOffset;
    let pagesCompleted =
      resumeOffset > 0 ? Math.floor(resumeOffset / batchSize) : 0;

    while (total === null || offset < total) {
      const data = await fetchPageWithRetry(appId, offset, options);

      if (total === null) {
        // Podio returns filtered count in data.filtered when filters are active
        total = data.filtered ?? data.total ?? 0;
        logger.info(
          `[Reseed] ${appLabel}: ${total} items to fetch${(options.dateFrom || options.dateTo) ? " (date-filtered)" : ""}`,
        );

        if (total === 0) {
          logger.info(`[Reseed] ${appLabel}: no items to seed`);
          break;
        }
      }

      if (data.items?.length) {
        const docs = data.items.map((raw) => {
          const transformed = transformAppItem({
            ...raw,
            app_id: appIdNum,
          });
          return {
            ...transformed,
            syncStatus: "success",
            lastSyncedAt: new Date(),
            syncError: null,
          };
        });

        logger.debug(
          `[Reseed] Inserting ${docs.length} docs into shadow at offset ${offset}...`,
        );
        try {
          const result = await shadowCollection.insertMany(docs, { ordered: false });
          const insertedCount = result.insertedCount || docs.length;
          fetched += insertedCount;

          if (insertedCount < docs.length) {
            logger.warn(
              `[Reseed] ${appLabel}: only ${insertedCount}/${docs.length} items inserted at offset ${offset} (duplicates skipped)`,
            );
          }
        } catch (insertErr) {
          if (insertErr.code === 11000 || insertErr.message?.includes("E11000")) {
            const insertedCount = insertErr.result?.insertedCount || 0;
            fetched += insertedCount;
            logger.debug(
              `[Reseed] ${appLabel}: ${insertedCount} new + ${docs.length - insertedCount} duplicates at offset ${offset}`,
            );
          } else {
            throw insertErr;
          }
        }
      }

      pagesCompleted++;

      // Checkpoint
      await AppSchema.findOneAndUpdate(
        { appId: appIdNum },
        { reseedProgress: { current: fetched, total } },
      );

      // ETA calculation
      const totalPages = Math.ceil(total / batchSize);
      const elapsedMs = Date.now() - fetchStartTime;
      const pagesFromStart =
        pagesCompleted - (resumeOffset > 0 ? Math.floor(resumeOffset / batchSize) : 0);
      const msPerPage = pagesFromStart > 0 ? elapsedMs / pagesFromStart : 0;
      const remainingPages = totalPages - pagesCompleted;
      const etaSeconds = msPerPage > 0 ? (remainingPages * msPerPage) / 1000 : 0;

      logger.info(
        `[Reseed] ${appLabel}: page ${pagesCompleted}/${totalPages} | ${fetched}/${total} items | ETA: ${formatDuration(etaSeconds)}`,
      );

      offset += batchSize;

      if (offset < total) {
        await sleep(config.SEED_DELAY_MS);
      }
    }

    // ── Phase 2: Validate ──────────────────────────────────────────────────
    logger.debug(`[Reseed] ${appLabel}: counting shadow collection docs...`);
    const shadowCount = await shadowCollection.countDocuments();

    if (total > 0 && shadowCount === 0) {
      throw new Error(
        `Shadow collection is empty but Podio reported ${total} items`,
      );
    }

    logger.info(`[Reseed] ${appLabel}: shadow has ${shadowCount} docs, expected ${total}`);

    const tolerance = Math.max(10, Math.ceil(total * 0.02));
    if (Math.abs(shadowCount - total) > tolerance) {
      logger.warn(
        `[Reseed] ${appLabel}: count mismatch — shadow=${shadowCount}, podio=${total} (tolerance=${tolerance}). Proceeding anyway.`,
      );
    }

    logger.info(
      `[Reseed] ${appLabel}: shadow has ${shadowCount} docs, Podio reported ${total}`,
    );

    // ── Phase 2.5: Save app schema snapshot ──────────────────────────────
    try {
      logger.debug(`[Reseed] Fetching app schema for app ${appId}...`);
      const { data: appData } = await podioClient.get(`/app/${appId}`, {
        timeout: 300_000,
      });
      const fieldsHash = crypto
        .createHash("md5")
        .update(JSON.stringify(appData.fields))
        .digest("hex");

      await AppSchema.findOneAndUpdate(
        { appId: appIdNum },
        {
          appName: appData.config?.name || null,
          fields: appData.fields,
          fieldsHash,
          lastSyncedAt: new Date(),
        },
        { upsert: true },
      );
      logger.info(
        `[Reseed] ${appLabel}: schema snapshot saved (${appData.fields?.length || 0} fields)`,
      );
    } catch (schemaErr) {
      logger.warn(
        `[Reseed] ${appLabel}: failed to save schema snapshot: ${schemaErr.message}`,
      );
    }

    // ── Phase 3: Swap ──────────────────────────────────────────────────────
    logger.debug(
      `[Reseed] ${appLabel}: starting swap — soft-deleting old items...`,
    );
    await AppItems.delete({ appId: appIdNum });
    logger.info(`[Reseed] ${appLabel}: old items soft-deleted`);

    const appItemsCollectionName = AppItems.collection.collectionName;
    logger.debug(
      `[Reseed] ${appLabel}: merging shadow into ${appItemsCollectionName}...`,
    );
    await shadowCollection
      .aggregate([
        { $unset: "_id" },
        {
          $merge: {
            into: appItemsCollectionName,
            on: ["itemId", "appId"],
            whenMatched: "replace",
            whenNotMatched: "insert",
          },
        },
      ])
      .toArray();

    logger.info(
      `[Reseed] ${appLabel}: shadow merged into ${appItemsCollectionName}`,
    );

    logger.debug(
      `[Reseed] ${appLabel}: cleaning up old soft-deleted items...`,
    );
    const mainCollection = mongoose.connection.collection(
      appItemsCollectionName,
    );
    await mainCollection.deleteMany({
      appId: appIdNum,
      deleted: true,
      deletedAt: { $gte: swapStartTime },
    });

    logger.debug(`[Reseed] ${appLabel}: dropping shadow collection...`);
    await shadowCollection.drop();
    logger.info(`[Reseed] ${appLabel}: shadow collection dropped`);

    // ── Phase 4: Finalize ──────────────────────────────────────────────────
    await AppSchema.findOneAndUpdate(
      { appId: appIdNum },
      {
        reseedStatus: "completed",
        lastSyncedAt: new Date(),
        reseedProgress: { current: fetched, total: total || 0 },
        reseedError: null,
      },
    );

    const totalElapsed = Math.round((Date.now() - fetchStartTime) / 1000);
    logger.info(
      `[Reseed] ${appLabel}: reseed completed successfully (${fetched} items in ${formatDuration(totalElapsed)})`,
    );

    if (lockAcquired) await releaseLock(lockKey);
    return "success";
  } catch (err) {
    logger.error(`[Reseed] App ${appId} failed: ${err.message}`);

    try {
      const mainCollection = mongoose.connection.collection(
        AppItems.collection.collectionName,
      );
      await mainCollection.updateMany(
        { appId: appIdNum, deleted: true, deletedAt: { $gte: swapStartTime } },
        { $set: { deleted: false }, $unset: { deletedAt: 1 } },
      );
      logger.info(`[Reseed] ${appLabel}: old items restored from soft-delete`);
    } catch (restoreErr) {
      logger.error(
        `[Reseed] ${appLabel}: restore failed: ${restoreErr.message}`,
      );
    }

    logger.info(
      `[Reseed] ${appLabel}: shadow collection preserved for resume/inspection`,
    );

    await AppSchema.findOneAndUpdate(
      { appId: appIdNum },
      {
        reseedStatus: "failed",
        reseedError: err.message,
      },
    );

    if (lockAcquired) await releaseLock(lockKey);
    throw err;
  }
}

/**
 * Clean up stale reseeds on startup.
 */
async function cleanupStaleReseeds() {
  try {
    const stale = await AppSchema.find({ reseedStatus: "in_progress" });
    for (const schema of stale) {
      logger.warn(
        `[Reseed] Found stale in-progress reseed for app ${schema.appId}. Restoring data...`,
      );

      const mainCollection = mongoose.connection.collection(
        AppItems.collection.collectionName,
      );
      const restored = await mainCollection.updateMany(
        { appId: schema.appId, deleted: true },
        { $set: { deleted: false }, $unset: { deletedAt: 1 } },
      );
      if (restored.modifiedCount > 0) {
        logger.info(
          `[Reseed] App ${schema.appId}: restored ${restored.modifiedCount} soft-deleted items`,
        );
      }

      try {
        await releaseLock(`reseed-lock-${schema.appId}`);
      } catch (e) {
        // Redis might not be available
      }

      await AppSchema.findOneAndUpdate(
        { appId: schema.appId },
        {
          reseedStatus: "failed",
          reseedError:
            "Server restarted during reseed. Old data restored. Shadow preserved for resume.",
        },
      );
    }
  } catch (err) {
    logger.error(`[Reseed] Cleanup check failed: ${err.message}`);
  }
}

/**
 * Create and return the secondary worker.
 */
function createSecondaryWorker() {
  const worker = new Worker(
    "podio-app-events",
    async (job) => {
      const { type, appId } = job.data;

      if (type === "app.update") {
        logger.info(`[Secondary] Processing app.update for app ${appId}`);

        let currentFields;
        try {
          const { data } = await podioClient.get(`/app/${appId}`);
          currentFields = data.fields;
        } catch (err) {
          const status = err.response?.status;
          if (status && status >= 400 && status < 500) {
            throw new UnrecoverableError(
              `Podio ${status} fetching app ${appId} schema`,
            );
          }
          throw err;
        }

        const currentHash = crypto
          .createHash("md5")
          .update(JSON.stringify(currentFields))
          .digest("hex");

        const stored = await AppSchema.findOne({ appId: Number(appId) });

        if (stored?.fieldsHash === currentHash) {
          logger.info(`[Secondary] App ${appId} schema unchanged. Skipping.`);
          return;
        }

        const changes = diffSchemas(stored?.fields || [], currentFields);
        logger.info(
          `[Secondary] App ${appId} schema changes: ${JSON.stringify(changes)}`,
        );

        await AppSchema.findOneAndUpdate(
          { appId: Number(appId) },
          {
            fields: currentFields,
            previousFields: stored?.fields || [],
            fieldsHash: currentHash,
            lastSyncedAt: new Date(),
          },
          { upsert: true },
        );

        const structuralTypes = [
          "field_added",
          "field_deleted",
          "field_renamed",
          "field_type_changed",
          "category_options_changed",
        ];
        const structural = changes.filter((c) =>
          structuralTypes.includes(c.type),
        );
        const triggeredReseed = structural.length > 0;

        let reseedResult = null;
        let reseedError = null;

        if (triggeredReseed) {
          logger.info(
            `[Secondary] ${structural.length} structural changes detected for app ${appId}. Triggering reseed.`,
          );
          try {
            await reseedApp(appId);
            reseedResult = "success";
          } catch (err) {
            reseedResult = "failed";
            reseedError = err.message;
          }
        }

        const appConfig = apps.find((a) => a.appId === Number(appId));
        await AppSchemaLogs.create({
          appId: Number(appId),
          appName: appConfig?.name || null,
          changes,
          detectedAt: new Date(),
          triggeredReseed,
          reseedResult,
          reseedError,
          fieldsHashBefore: stored?.fieldsHash || null,
          fieldsHashAfter: currentHash,
        });

        logger.info(`[Secondary] Schema change log saved for app ${appId}`);
      }

      if (type === "app.delete") {
        logger.info(`[Secondary] Processing app.delete for app ${appId}`);

        await AppItems.delete({ appId: Number(appId) });
        await AppSchema.findOneAndDelete({ appId: Number(appId) });

        logger.info(
          `[Secondary] App ${appId}: all items soft-deleted, schema removed`,
        );
      }
    },
    { connection: createDuplicate(), concurrency: 1, lockDuration: 7_200_000 },
  );

  worker.on("completed", (job) => {
    logger.info(
      `[Secondary] Job completed: ${job?.data?.type} for app ${job?.data?.appId}`,
    );
  });

  worker.on("failed", (job, err) => {
    logger.error(
      `[Secondary] Job failed: ${job?.data?.type} for app ${job?.data?.appId}: ${err.message}`,
    );
  });

  return worker;
}

module.exports = { createSecondaryWorker, reseedApp, cleanupStaleReseeds };
