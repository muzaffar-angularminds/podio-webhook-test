/**
 * Seed all apps — runs seedApp for every app in config/apps.js sequentially.
 * Apps share the 250/hr rate limit, so they run one at a time.
 *
 * Usage:
 *   node src/scripts/seedAll.js
 *   node src/scripts/seedAll.js --force
 *   node src/scripts/seedAll.js --from=2026-01-01 --to=2026-04-07
 *   node src/scripts/seedAll.js --batch_size=200
 */
const mongoose = require("mongoose");
const config = require("../config/config");
const apps = require("../config/apps");
const logger = require("../config/logger");
const { reseedApp } = require("../queues/secondaryWorker");
const AppItems = require("../models/app-items.model");
const AppSchema = require("../models/app-schema.model");

const args = process.argv.slice(2);
const isForce = args.includes("--force");
const fromArg = args.find((a) => a.startsWith("--from="));
const toArg = args.find((a) => a.startsWith("--to="));
const batchSizeArg = args.find((a) => a.startsWith("--batch_size="));

const dateFrom = fromArg ? fromArg.split("=")[1] : null;
const dateTo = toArg ? toArg.split("=")[1] : null;
const batchSizeOverride = batchSizeArg ? parseInt(batchSizeArg.split("=")[1]) : null;

let isInterrupted = false;
let redisConnected = false;

(async () => {
  try {
    await mongoose.connect(config.MONGODB_URL);
    logger.info(`[SeedAll] Connected to MongoDB`);

    // Connect Redis for distributed lock
    try {
      const { redis } = require("../config/redis");
      await new Promise((resolve, reject) => {
        if (redis.status === "ready") return resolve();
        redis.once("ready", resolve);
        redis.once("error", reject);
        setTimeout(() => reject(new Error("Redis connection timeout")), 5000);
      });
      redisConnected = true;
      logger.info(`[SeedAll] Connected to Redis`);
    } catch (redisErr) {
      logger.warn(`[SeedAll] Redis unavailable: ${redisErr.message}. Proceeding without lock.`);
    }

    // Handle Ctrl+C
    process.on("SIGINT", async () => {
      if (isInterrupted) return;
      isInterrupted = true;
      logger.warn(`[SeedAll] Interrupted (Ctrl+C).`);
      await cleanup();
      process.exit(1);
    });

    const seedOptions = {};
    if (dateFrom) seedOptions.dateFrom = dateFrom;
    if (dateTo) seedOptions.dateTo = dateTo;
    if (batchSizeOverride) seedOptions.batchSize = batchSizeOverride;

    const totalStart = Date.now();
    logger.info(`[SeedAll] Seeding ${apps.length} apps sequentially${isForce ? " [FORCE]" : ""}`);
    if (dateFrom || dateTo) {
      logger.info(`[SeedAll] Date filter: from=${dateFrom || "beginning"} to=${dateTo || "now"}`);
    }

    const results = [];

    for (let i = 0; i < apps.length; i++) {
      if (isInterrupted) break;

      const app = apps[i];
      logger.info(`\n[SeedAll] ── App ${i + 1}/${apps.length}: ${app.name} (${app.appId}) ──`);

      // Check if needs seeding
      const existingCount = await AppItems.countDocuments({ appId: app.appId });
      const schema = await AppSchema.findOne({ appId: app.appId });

      if (existingCount > 0 && !isForce) {
        logger.info(`[SeedAll] App ${app.appId} already has ${existingCount} items, skipping (use --force)`);
        results.push({ appId: app.appId, name: app.name, status: "skipped", reason: "data exists" });
        continue;
      }

      if (schema?.reseedStatus === "in_progress") {
        logger.warn(`[SeedAll] App ${app.appId} has reseed in progress, skipping`);
        results.push({ appId: app.appId, name: app.name, status: "skipped", reason: "in progress" });
        continue;
      }

      // If force, reset state
      if (isForce) {
        try {
          await mongoose.connection.collection(`podio_items_staging_${app.appId}`).drop();
        } catch (e) {
          // doesn't exist
        }
        await AppSchema.findOneAndUpdate(
          { appId: app.appId },
          { reseedStatus: "idle", reseedProgress: { current: 0, total: 0 }, reseedError: null },
          { upsert: true },
        );
      }

      const appStart = Date.now();
      try {
        await reseedApp(app.appId, seedOptions);
        const elapsed = Math.round((Date.now() - appStart) / 1000);
        logger.info(`[SeedAll] App ${app.appId} (${app.name}): completed in ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
        results.push({ appId: app.appId, name: app.name, status: "success", elapsed });
      } catch (err) {
        logger.error(`[SeedAll] App ${app.appId} (${app.name}): failed — ${err.message}`);
        results.push({ appId: app.appId, name: app.name, status: "failed", error: err.message });
      }
    }

    // Summary
    const totalElapsed = Math.round((Date.now() - totalStart) / 1000);
    logger.info(`\n[SeedAll] ── Summary ──`);
    for (const r of results) {
      const icon = r.status === "success" ? "OK" : r.status === "skipped" ? "SKIP" : "FAIL";
      logger.info(`[SeedAll]   ${icon}  ${r.name} (${r.appId})${r.elapsed ? ` — ${Math.floor(r.elapsed / 60)}m ${r.elapsed % 60}s` : ""}${r.reason ? ` — ${r.reason}` : ""}${r.error ? ` — ${r.error}` : ""}`);
    }
    logger.info(`[SeedAll] Total time: ${Math.floor(totalElapsed / 60)}m ${totalElapsed % 60}s`);
  } catch (err) {
    logger.error(`[SeedAll] Fatal: ${err.message}`);
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
    }
  } catch (e) {}
  try {
    await mongoose.disconnect();
    logger.info(`[SeedAll] Disconnected`);
  } catch (e) {}
}
