/**
 * Seed script — bulk fetch all items from a Podio app into MongoDB.
 *
 * Usage:
 *   node src/scripts/seedApp.js --app_id=30682880
 *   node src/scripts/seedApp.js --app_id=30682880 --resume    # Resume a failed/interrupted seed
 *   node src/scripts/seedApp.js --app_id=30682880 --force     # Force reseed even if data exists
 *
 * Uses the shadow collection + atomic swap approach for safe data migration.
 * Idempotent — re-running produces the same state.
 * Handles SIGINT (Ctrl+C) gracefully — marks reseed as failed, preserves shadow for resume.
 */
const mongoose = require("mongoose");
const config = require("../config/config");
const logger = require("../config/logger");

// Parse CLI args
const args = process.argv.slice(2);
const appIdArg = args.find((a) => a.startsWith("--app_id="));
const isResume = args.includes("--resume");
const isForce = args.includes("--force");

if (!appIdArg) {
  console.error("Usage: node src/scripts/seedApp.js --app_id=YOUR_APP_ID [--resume] [--force]");
  console.error("");
  console.error("Options:");
  console.error("  --app_id=ID    Podio app ID to seed (required)");
  console.error("  --resume       Resume a previously failed/interrupted seed");
  console.error("  --force        Force reseed even if data already exists");
  process.exit(1);
}

const appId = appIdArg.split("=")[1];
let isInterrupted = false;

(async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(config.MONGODB_URL);
    logger.info(`[Seed] Connected to MongoDB`);

    // Verify app exists in registry
    const PodioApp = require("../db/podio-app.model");
    const PodioItem = require("../db/podio-item.model");
    const AppSchema = require("../db/app-schema.model");

    const app = await PodioApp.findOne({ appId: Number(appId), isActive: true });
    if (!app) {
      logger.error(`[Seed] App ${appId} not found or inactive. Register it at /admin/apps first.`);
      process.exit(1);
    }

    // Check current state
    const schema = await AppSchema.findOne({ appId: Number(appId) });
    const existingCount = await PodioItem.countDocuments({ appId: Number(appId) });

    if (schema?.reseedStatus === "in_progress" && !isResume) {
      logger.error(`[Seed] App ${appId} has a reseed in progress. Use --resume to continue it.`);
      process.exit(1);
    }

    if (schema?.reseedStatus === "failed" && !isResume && !isForce) {
      logger.error(
        `[Seed] App ${appId} has a failed reseed (${schema.reseedError}). Use --resume to continue or --force to start fresh.`,
      );
      process.exit(1);
    }

    if (existingCount > 0 && !isForce && !isResume) {
      logger.warn(
        `[Seed] App ${appId} already has ${existingCount} items in DB. Use --force to reseed or --resume if a previous seed was interrupted.`,
      );
      process.exit(1);
    }

    // If --resume and status is "failed", set it back to "in_progress" so reseedApp picks up the checkpoint
    if (isResume && schema?.reseedStatus === "failed") {
      await AppSchema.findOneAndUpdate(
        { appId: Number(appId) },
        { reseedStatus: "in_progress" },
      );
    }

    // If --force, drop any existing shadow and reset state
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

    // Handle Ctrl+C gracefully
    process.on("SIGINT", async () => {
      if (isInterrupted) return;
      isInterrupted = true;
      logger.warn(`[Seed] Interrupted (Ctrl+C). Preserving shadow for resume...`);
      await AppSchema.findOneAndUpdate(
        { appId: Number(appId) },
        { reseedStatus: "failed", reseedError: "Interrupted by user (SIGINT)" },
      );
      logger.info(`[Seed] Run with --resume to continue from where you left off.`);
      await mongoose.disconnect();
      process.exit(1);
    });

    const startTime = Date.now();
    logger.info(`[Seed] Starting seed for app ${appId} (${app.appName || "unnamed"})${isResume ? " [RESUME]" : ""}${isForce ? " [FORCE]" : ""}`);

    // Import and run reseed
    const { reseedApp } = require("../queues/secondaryWorker");
    await reseedApp(appId);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    logger.info(`[Seed] Completed for app ${appId} in ${minutes}m ${seconds}s`);
  } catch (err) {
    if (!isInterrupted) {
      logger.error(`[Seed] Failed: ${err.message}`);
      logger.info(`[Seed] Run with --resume to continue from the last checkpoint.`);
    }
    process.exit(1);
  } finally {
    if (!isInterrupted) {
      await mongoose.disconnect();
      logger.info(`[Seed] Disconnected from MongoDB`);
      process.exit(0);
    }
  }
})();
