const { Queue } = require("bullmq");
const config = require("../config/config");

const connection = config.REDIS_URL;

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 500 },
};

// Flush triggers — delayed jobs that fire the batch fetch for an app
const flushQueue = new Queue("podio-flush", {
  connection,
  defaultJobOptions,
});

// Batch fetch jobs — rate-limited, one job per batch of item IDs
const batchQueue = new Queue("podio-batches", {
  connection,
  defaultJobOptions,
});

// App-level events (app.update, app.delete) — for future use
const appQueue = new Queue("podio-app-events", {
  connection,
  defaultJobOptions,
});

// Seed jobs — for initial/reseed operations
const seedQueue = new Queue("podio-seed", {
  connection,
  defaultJobOptions,
});

module.exports = { flushQueue, batchQueue, appQueue, seedQueue, connection };
