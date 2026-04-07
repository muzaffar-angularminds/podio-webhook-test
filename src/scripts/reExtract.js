/**
 * Re-extract script — rebuilds transformedFields from rawFields without calling Podio.
 * Pure DB operation. Use when you add/remove fields in extractFields config.
 *
 * Usage:
 *   node src/scripts/reExtract.js --app_id=13038875
 *   node src/scripts/reExtract.js --all
 */
const mongoose = require("mongoose");
const config = require("../config/config");
const apps = require("../config/apps");
const logger = require("../config/logger");
const AppItems = require("../models/app-items.model");
const { extractFieldValue } = require("../utils/extractFieldValue");

const args = process.argv.slice(2);
const appIdArg = args.find((a) => a.startsWith("--app_id="));
const isAll = args.includes("--all");

if (!appIdArg && !isAll) {
  console.error("Usage: node src/scripts/reExtract.js --app_id=YOUR_APP_ID");
  console.error("       node src/scripts/reExtract.js --all");
  console.error("");
  console.error("Rebuilds transformedFields from rawFields using current extractFields config.");
  console.error("No Podio API calls — pure DB operation.");
  process.exit(1);
}

const toKey = (externalId) => externalId.replace(/-/g, "_");

async function reExtractApp(appConfig) {
  const { appId, name, extractFields } = appConfig;

  if (!extractFields || extractFields.length === 0) {
    logger.warn(`[ReExtract] App ${appId} (${name}): no extractFields configured, skipping`);
    return;
  }

  logger.info(`[ReExtract] App ${appId} (${name}): starting re-extraction (${extractFields.length} fields)...`);

  const cursor = AppItems.find({ appId }).cursor();
  let processed = 0;
  let batch = [];

  try {
  for await (const item of cursor) {
    const rawFields = item.rawFields instanceof Map
      ? Object.fromEntries(item.rawFields)
      : item.rawFields;

    if (!rawFields) {
      processed++;
      continue;
    }

    const transformedFields = {};
    for (const externalId of extractFields) {
      if (rawFields[externalId]) {
        transformedFields[toKey(externalId)] = extractFieldValue(rawFields[externalId]);
      }
    }

    batch.push({
      updateOne: {
        filter: { _id: item._id },
        update: { $set: { transformedFields } },
      },
    });

    if (batch.length >= 500) {
      await AppItems.bulkWrite(batch, { ordered: false });
      processed += batch.length;
      logger.info(`[ReExtract] App ${appId}: ${processed} items processed`);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await AppItems.bulkWrite(batch, { ordered: false });
    processed += batch.length;
  }
  } finally {
    await cursor.close();
  }

  logger.info(`[ReExtract] App ${appId} (${name}): done — ${processed} items updated`);
}

(async () => {
  try {
    await mongoose.connect(config.MONGODB_URL);
    logger.info(`[ReExtract] Connected to MongoDB`);

    const startTime = Date.now();
    const appsToProcess = isAll
      ? apps
      : apps.filter((a) => a.appId === Number(appIdArg.split("=")[1]));

    if (appsToProcess.length === 0) {
      logger.error(`[ReExtract] No matching app found in config/apps.js`);
      process.exit(1);
    }

    for (const appConfig of appsToProcess) {
      await reExtractApp(appConfig);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logger.info(`[ReExtract] All done in ${elapsed}s`);
  } catch (err) {
    logger.error(`[ReExtract] Failed: ${err.message}`);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    logger.info(`[ReExtract] Disconnected from MongoDB`);
    process.exit(0);
  }
})();
