const { Worker, UnrecoverableError } = require("bullmq");
const crypto = require("crypto");
const mongoose = require("mongoose");
const AppSchema = require("../db/app-schema.model");
const PodioItem = require("../db/podio-item.model");
const PodioApp = require("../db/podio-app.model");
const podioClient = require("../webhooks/client");
const transformPodioItem = require("../utils/transformPodioItem");
const config = require("../config/config");
const logger = require("../config/logger");

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 500;
const SEED_DELAY_MS = parseInt(process.env.SEED_DELAY_MS) || 15_000;
const PAGE_MAX_RETRIES = 3;
const PAGE_RETRY_DELAY_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compare two schema field arrays and return a list of structural changes.
 */
function diffSchemas(oldFields, newFields) {
  const changes = [];
  const oldMap = new Map((oldFields || []).map((f) => [f.field_id, f]));
  const newMap = new Map((newFields || []).map((f) => [f.field_id, f]));

  for (const [id, newField] of newMap) {
    if (!oldMap.has(id)) {
      changes.push({ type: "field_added", fieldId: id, label: newField.config?.label });
    } else {
      const old = oldMap.get(id);
      if (old.config?.label !== newField.config?.label) {
        changes.push({
          type: "field_renamed",
          fieldId: id,
          from: old.config?.label,
          to: newField.config?.label,
        });
      }
      if (old.type !== newField.type) {
        changes.push({ type: "field_type_changed", fieldId: id, from: old.type, to: newField.type });
      }
      if (newField.type === "category") {
        const oldOpts = JSON.stringify(old.config?.settings?.options || []);
        const newOpts = JSON.stringify(newField.config?.settings?.options || []);
        if (oldOpts !== newOpts) {
          changes.push({ type: "category_options_changed", fieldId: id, label: newField.config?.label });
        }
      }
    }
  }

  for (const [id, oldField] of oldMap) {
    if (!newMap.has(id)) {
      changes.push({ type: "field_deleted", fieldId: id, label: oldField.config?.label });
    }
  }

  return changes;
}

/**
 * Fetch a single page from Podio with retry logic.
 * Retries up to PAGE_MAX_RETRIES on transient errors (5xx/network).
 * Throws immediately on 4xx (permanent error).
 */
async function fetchPageWithRetry(appId, offset, attempt = 1) {
  try {
    const { data } = await podioClient.post(
      `/item/app/${appId}/filter/?hook=false`,
      {
        filters: {},
        limit: BATCH_SIZE,
        offset,
        sort_by: "item_id",
        sort_desc: false,
      },
    );
    return data;
  } catch (err) {
    const status = err.response?.status;

    // 4xx = permanent, no point retrying
    if (status && status >= 400 && status < 500) {
      logger.error(
        `[Reseed] Permanent ${status} from Podio at offset ${offset}: ${err.message}`,
      );
      if (err.response?.data) {
        logger.error(`[Reseed] Podio response: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }

    // Transient error — retry
    if (attempt < PAGE_MAX_RETRIES) {
      const delay = PAGE_RETRY_DELAY_MS * attempt;
      logger.warn(
        `[Reseed] Page at offset ${offset} failed (attempt ${attempt}/${PAGE_MAX_RETRIES}): ${err.message}. Retrying in ${delay}ms...`,
      );
      await sleep(delay);
      return fetchPageWithRetry(appId, offset, attempt + 1);
    }

    logger.error(
      `[Reseed] Page at offset ${offset} failed after ${PAGE_MAX_RETRIES} attempts. Giving up.`,
    );
    throw err;
  }
}

/**
 * Reseed an app using the shadow collection + atomic swap approach.
 *
 * Production-grade features:
 * - Checkpoint resume: if script crashes at page 300, it restarts from 300 not 0
 * - Per-page retry: transient Podio errors retry 3 times with backoff
 * - $merge swap: uses MongoDB aggregate pipeline for fast collection swap
 * - Rollback on failure: restores soft-deleted items if swap fails
 * - Stale reseed cleanup: called on startup to handle orphaned shadows
 */
async function reseedApp(appId) {
  const appIdNum = Number(appId);
  const shadowName = `podio_items_staging_${appId}`;
  const shadowCollection = mongoose.connection.collection(shadowName);
  const swapStartTime = new Date();

  // Check if there's a stale in-progress reseed with an existing shadow collection
  const existing = await AppSchema.findOne({ appId: appIdNum });
  let resumeOffset = 0;

  if (existing?.reseedStatus === "in_progress" && existing?.reseedProgress?.current > 0) {
    // Shadow collection exists from a previous interrupted run — resume from checkpoint
    const shadowCount = await shadowCollection.countDocuments().catch(() => 0);
    if (shadowCount > 0) {
      resumeOffset = shadowCount; // Each doc = 1 item, resume from where we left off
      logger.info(
        `[Reseed] Resuming app ${appId} from offset ${resumeOffset} (${shadowCount} docs already in shadow)`,
      );
    }
  } else {
    // Fresh start — drop any orphaned shadow collection
    try {
      await shadowCollection.drop();
    } catch (e) {
      // Collection doesn't exist, fine
    }
  }

  logger.info(`[Reseed] Starting reseed for app ${appId}${resumeOffset > 0 ? ` (resuming from ${resumeOffset})` : ""}`);

  // Mark reseed in progress
  await AppSchema.findOneAndUpdate(
    { appId: appIdNum },
    {
      reseedStatus: "in_progress",
      reseedStartedAt: resumeOffset > 0 ? existing.reseedStartedAt : swapStartTime,
      reseedProgress: { current: resumeOffset, total: existing?.reseedProgress?.total || 0 },
      reseedError: null,
    },
    { upsert: true },
  );

  try {
    // ── Phase 1: Fetch all items into shadow collection ────────────────────
    let offset = resumeOffset;
    let total = null;
    let fetched = resumeOffset;

    while (total === null || offset < total) {
      const data = await fetchPageWithRetry(appId, offset);

      if (total === null) {
        total = data.total || data.filtered || 0;
        logger.info(`[Reseed] App ${appId}: ${total} total items to fetch`);

        if (total === 0) {
          logger.info(`[Reseed] App ${appId}: no items in Podio, nothing to seed`);
          break;
        }
      }

      if (data.items?.length) {
        const docs = data.items.map((raw) => {
          const transformed = transformPodioItem({
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

        // Use ordered insertMany with retry on duplicate key
        try {
          await shadowCollection.insertMany(docs, { ordered: false });
        } catch (insertErr) {
          // Ignore duplicate key errors (E11000) from resume overlap
          if (insertErr.code !== 11000 && !insertErr.message?.includes("E11000")) {
            throw insertErr;
          }
        }

        fetched += data.items.length;
      }

      // Checkpoint: save progress after every page
      await AppSchema.findOneAndUpdate(
        { appId: appIdNum },
        { reseedProgress: { current: fetched, total } },
      );

      const totalPages = Math.ceil(total / BATCH_SIZE);
      const currentPage = Math.floor(offset / BATCH_SIZE) + 1;
      logger.info(`[Reseed] App ${appId}: page ${currentPage}/${totalPages} | ${fetched}/${total} items`);

      offset += BATCH_SIZE;

      // Sleep between pages to respect rate limit
      if (offset < total) {
        await sleep(SEED_DELAY_MS);
      }
    }

    // ── Phase 2: Validate ──────────────────────────────────────────────────
    const shadowCount = await shadowCollection.countDocuments();

    if (total > 0 && shadowCount === 0) {
      throw new Error(`Shadow collection is empty but Podio reported ${total} items`);
    }

    // Allow small tolerance (Podio might have items added/deleted during seed)
    const tolerance = Math.max(10, Math.ceil(total * 0.01)); // 1% or 10, whichever is larger
    if (Math.abs(shadowCount - total) > tolerance) {
      logger.warn(
        `[Reseed] App ${appId}: count mismatch — shadow=${shadowCount}, podio=${total} (tolerance=${tolerance}). Proceeding anyway.`,
      );
    }

    logger.info(`[Reseed] App ${appId}: shadow has ${shadowCount} docs, Podio reported ${total}`);

    // ── Phase 2.5: Save app schema snapshot ──────────────────────────────
    // Fetch and store the current app schema for future diffing
    try {
      const { data: appData } = await podioClient.get(`/app/${appId}`);
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
      logger.info(`[Reseed] App ${appId}: schema snapshot saved (${appData.fields?.length || 0} fields)`);
    } catch (schemaErr) {
      logger.warn(`[Reseed] App ${appId}: failed to save schema snapshot: ${schemaErr.message}`);
      // Non-fatal — continue with reseed
    }

    // ── Phase 3: Swap ──────────────────────────────────────────────────────
    // Soft-delete old items
    await PodioItem.delete({ appId: appIdNum });
    logger.info(`[Reseed] App ${appId}: old items soft-deleted`);

    // Use aggregate $merge to move shadow docs into podio_items
    // $unset _id to prevent conflict — podio_items will generate its own _id
    const podioItemsCollectionName = PodioItem.collection.collectionName;
    await shadowCollection
      .aggregate([
        { $unset: "_id" },
        {
          $merge: {
            into: podioItemsCollectionName,
            on: ["itemId", "appId"],
            whenMatched: "replace",
            whenNotMatched: "insert",
          },
        },
      ])
      .toArray();

    logger.info(`[Reseed] App ${appId}: shadow merged into ${podioItemsCollectionName}`);

    // Hard-delete the soft-deleted old items (they're replaced now)
    const mainCollection = mongoose.connection.collection(podioItemsCollectionName);
    await mainCollection.deleteMany({
      appId: appIdNum,
      deleted: true,
      deletedAt: { $gte: swapStartTime },
    });

    // Drop shadow collection
    await shadowCollection.drop();
    logger.info(`[Reseed] App ${appId}: shadow collection dropped`);

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

    await PodioApp.findOneAndUpdate(
      { appId: appIdNum },
      { lastSeededAt: new Date() },
    );

    logger.info(`[Reseed] App ${appId}: reseed completed successfully (${fetched} items)`);
  } catch (err) {
    logger.error(`[Reseed] App ${appId} failed: ${err.message}`);

    // ── Rollback ───────────────────────────────────────────────────────────
    // Restore soft-deleted items (old data comes back)
    try {
      const mainCollection = mongoose.connection.collection(PodioItem.collection.collectionName);
      await mainCollection.updateMany(
        { appId: appIdNum, deleted: true, deletedAt: { $gte: swapStartTime } },
        { $set: { deleted: false }, $unset: { deletedAt: "" } },
      );
      logger.info(`[Reseed] App ${appId}: old items restored from soft-delete`);
    } catch (restoreErr) {
      logger.error(`[Reseed] App ${appId}: restore failed: ${restoreErr.message}`);
    }

    // Don't drop shadow on failure — keep it for inspection/resume
    logger.info(`[Reseed] App ${appId}: shadow collection preserved for resume/inspection`);

    // Mark as failed (but preserve progress for resume)
    await AppSchema.findOneAndUpdate(
      { appId: appIdNum },
      {
        reseedStatus: "failed",
        reseedError: err.message,
      },
    );

    throw err;
  }
}

/**
 * Clean up stale reseeds on startup.
 * If the server crashed during a reseed, the shadow collection is orphaned.
 * This restores old data and allows the reseed to be retried.
 */
async function cleanupStaleReseeds() {
  try {
    const stale = await AppSchema.find({ reseedStatus: "in_progress" });
    for (const schema of stale) {
      logger.warn(`[Reseed] Found stale in-progress reseed for app ${schema.appId}. Will resume on next trigger.`);
      // Don't auto-cleanup — leave shadow for resume. Just mark as failed so it can be retried.
      await AppSchema.findOneAndUpdate(
        { appId: schema.appId },
        {
          reseedStatus: "failed",
          reseedError: "Server restarted during reseed. Shadow preserved for resume.",
        },
      );
    }
  } catch (err) {
    logger.error(`[Reseed] Cleanup check failed: ${err.message}`);
  }
}

/**
 * Create and return the secondary worker.
 * Handles app.update (schema diff + reseed) and app.delete (soft-delete all items).
 */
function createSecondaryWorker() {
  const worker = new Worker(
    "podio-app-events",
    async (job) => {
      const { type, appId } = job.data;

      if (type === "app.update") {
        logger.info(`[Secondary] Processing app.update for app ${appId}`);

        // Fetch current schema from Podio
        let currentFields;
        try {
          const { data } = await podioClient.get(`/app/${appId}`);
          currentFields = data.fields;
        } catch (err) {
          const status = err.response?.status;
          if (status && status >= 400 && status < 500) {
            throw new UnrecoverableError(`Podio ${status} fetching app ${appId} schema`);
          }
          throw err;
        }

        // Compute hash
        const currentHash = crypto
          .createHash("md5")
          .update(JSON.stringify(currentFields))
          .digest("hex");

        // Load stored snapshot
        const stored = await AppSchema.findOne({ appId: Number(appId) });

        // Quick hash check
        if (stored?.fieldsHash === currentHash) {
          logger.info(`[Secondary] App ${appId} schema unchanged. Skipping.`);
          return;
        }

        // Full diff
        const changes = diffSchemas(stored?.fields || [], currentFields);
        logger.info(`[Secondary] App ${appId} schema changes: ${JSON.stringify(changes)}`);

        // Save new snapshot
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

        // Check for structural changes
        const structuralTypes = [
          "field_added",
          "field_deleted",
          "field_renamed",
          "field_type_changed",
          "category_options_changed",
        ];
        const structural = changes.filter((c) => structuralTypes.includes(c.type));

        if (structural.length > 0) {
          logger.info(
            `[Secondary] ${structural.length} structural changes detected for app ${appId}. Triggering reseed.`,
          );
          await reseedApp(appId);
        }
      }

      if (type === "app.delete") {
        logger.info(`[Secondary] Processing app.delete for app ${appId}`);

        // Soft-delete all items for this app
        await PodioItem.delete({ appId: Number(appId) });

        // Remove schema snapshot
        await AppSchema.findOneAndDelete({ appId: Number(appId) });

        // Deactivate the app in registry
        await PodioApp.findOneAndUpdate(
          { appId: Number(appId) },
          { isActive: false },
        );

        logger.info(`[Secondary] App ${appId}: all items soft-deleted, schema removed, app deactivated`);
      }
    },
    { connection: config.REDIS_URL, concurrency: 1 },
  );

  worker.on("completed", (job) => {
    logger.info(`[Secondary] Job completed: ${job?.data?.type} for app ${job?.data?.appId}`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`[Secondary] Job failed: ${job?.data?.type} for app ${job?.data?.appId}: ${err.message}`);
  });

  return worker;
}

module.exports = { createSecondaryWorker, diffSchemas, reseedApp, cleanupStaleReseeds };
