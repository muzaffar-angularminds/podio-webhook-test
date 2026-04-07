/**
 * Seed script — bulk fetch all items from a Podio app into MongoDB.
 *
 * Usage:
 *   node src/scripts/seedApp.js --app_id=30682880
 *   node src/scripts/seedApp.js --app_id=30682880 --resume
 *   node src/scripts/seedApp.js --app_id=30682880 --force
 *   node src/scripts/seedApp.js --app_id=30682880 --from=2025-01-01 --to=2025-12-31
 *   node src/scripts/seedApp.js --app_id=30682880 --batch_size=200
 */
const mongoose = require("mongoose");
const config = require("../config/config");
const apps = require("../config/apps");
const logger = require("../config/logger");

const args = process.argv.slice(2);
const appIdArg = args.find((a) => a.startsWith("--app_id="));
const isResume = args.includes("--resume");
const isForce = args.includes("--force");
const fromArg = args.find((a) => a.startsWith("--from="));
const toArg = args.find((a) => a.startsWith("--to="));
const batchSizeArg = args.find((a) => a.startsWith("--batch_size="));

if (!appIdArg) {
  console.error("Usage: node src/scripts/seedApp.js --app_id=YOUR_APP_ID [options]");
  console.error("");
  console.error("Options:");
  console.error("  --app_id=ID          Podio app ID to seed (required)");
  console.error("  --resume             Resume a previously failed/interrupted seed");
  console.error("  --force              Force reseed even if data already exists");
  console.error("  --from=YYYY-MM-DD    Only fetch items created on or after this date");
  console.error("  --to=YYYY-MM-DD      Only fetch items created on or before this date");
  console.error("  --batch_size=N       Items per page (default 500, try 200 for large apps)");
  process.exit(1);
}

const appId = appIdArg.split("=")[1];
const dateFrom = fromArg ? fromArg.split("=")[1] : null;
const dateTo = toArg ? toArg.split("=")[1] : null;
const batchSizeOverride = batchSizeArg ? parseInt(batchSizeArg.split("=")[1]) : null;
let isInterrupted = false;
let redisConnected = false;

(async () => {
  try {
    await mongoose.connect(config.MONGODB_URL);
    logger.info(`[Seed] Connected to MongoDB`);

    try {
      const { redis } = require("../config/redis");
      await new Promise((resolve, reject) => {
        if (redis.status === "ready") return resolve();
        redis.once("ready", resolve);
        redis.once("error", reject);
        setTimeout(() => reject(new Error("Redis connection timeout")), 5000);
      });
      redisConnected = true;
      logger.info(`[Seed] Connected to Redis`);
    } catch (redisErr) {
      logger.warn(`[Seed] Redis unavailable: ${redisErr.message}. Proceeding without distributed lock.`);
    }

    const appConfig = apps.find((a) => a.appId === Number(appId));
    if (!appConfig) {
      logger.error(`[Seed] App ${appId} not found in config/apps.js. Add it there first.`);
      process.exit(1);
    }

    const AppItems = require("../models/app-items.model");
    const AppSchema = require("../models/app-schema.model");

    const schema = await AppSchema.findOne({ appId: Number(appId) });
    const existingCount = await AppItems.countDocuments({ appId: Number(appId) });

    if (schema?.reseedStatus === "in_progress" && !isResume) {
      logger.error(`[Seed] ${appConfig.name} (${appId}) has a reseed in progress. Use --resume to continue it.`);
      process.exit(1);
    }

    if (schema?.reseedStatus === "failed" && !isResume && !isForce) {
      logger.error(
        `[Seed] ${appConfig.name} (${appId}) has a failed reseed (${schema.reseedError}). Use --resume to continue or --force to start fresh.`,
      );
      process.exit(1);
    }

    if (existingCount > 0 && !isForce && !isResume) {
      logger.warn(
        `[Seed] ${appConfig.name} (${appId}) already has ${existingCount} items in DB. Use --force to reseed or --resume if a previous seed was interrupted.`,
      );
      process.exit(1);
    }

    if (isResume && schema?.reseedStatus === "failed") {
      await AppSchema.findOneAndUpdate(
        { appId: Number(appId) },
        { reseedStatus: "in_progress" },
      );
    }

    if (isForce && !isResume) {
      try {
        await mongoose.connection.collection(`podio_items_staging_${appId}`).drop();
        logger.info(`[Seed] Dropped existing shadow collection for app ${appId}`);
      } catch (e) {
        // Doesn't exist, fine
      }
      await AppSchema.findOneAndUpdate(
        { appId: Number(appId) },
        { reseedStatus: "idle", reseedProgress: { current: 0, total: 0 }, reseedError: null },
        { upsert: true },
      );
    }

    process.on("SIGINT", async () => {
      if (isInterrupted) return;
      isInterrupted = true;
      logger.warn(`[Seed] Interrupted (Ctrl+C). Preserving shadow for resume...`);
      await AppSchema.findOneAndUpdate(
        { appId: Number(appId) },
        { reseedStatus: "failed", reseedError: "Interrupted by user (SIGINT)" },
      );
      logger.info(`[Seed] Run with --resume to continue from where you left off.`);
      await cleanup();
      process.exit(1);
    });

    // Build seed options
    const seedOptions = {};
    if (dateFrom) seedOptions.dateFrom = dateFrom;
    if (dateTo) seedOptions.dateTo = dateTo;
    if (batchSizeOverride) seedOptions.batchSize = batchSizeOverride;

    const effectiveBatchSize = batchSizeOverride || config.BATCH_SIZE;
    const startTime = Date.now();
    logger.info(`[Seed] Starting seed for app ${appId} (${appConfig.name})${isResume ? " [RESUME]" : ""}${isForce ? " [FORCE]" : ""}`);
    logger.info(`[Seed] Rate: ${Math.floor(3600000 / config.SEED_DELAY_MS)} pages/hr | Batch size: ${effectiveBatchSize}`);
    if (dateFrom || dateTo) {
      logger.info(`[Seed] Date filter: from=${dateFrom || "beginning"} to=${dateTo || "now"}`);
    }

    const { reseedApp } = require("../queues/secondaryWorker");
    await reseedApp(appId, seedOptions);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    logger.info(`[Seed] Completed ${appConfig.name} (${appId}) in ${minutes}m ${seconds}s`);
  } catch (err) {
    if (!isInterrupted) {
      logger.error(`[Seed] Failed: ${err.message}`);
      logger.info(`[Seed] Run with --resume to continue from the last checkpoint.`);
    }
    process.exit(1);
  } finally {
    if (!isInterrupted) {
      await cleanup();
      process.exit(0);
    }
  }
})();

async function cleanup() {
  try {
    if (redisConnected) {
      const { redis } = require("../config/redis");
      await redis.quit();
      logger.info(`[Seed] Disconnected from Redis`);
    }
  } catch (e) {
    // ignore
  }
  try {
    await mongoose.disconnect();
    logger.info(`[Seed] Disconnected from MongoDB`);
  } catch (e) {
    // ignore
  }
}
