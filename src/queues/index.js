const { Queue } = require("bullmq");
const { createDuplicate } = require("../config/redis");

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 500 },
};

const flushQueue = new Queue("podio-flush", {
  connection: createDuplicate(),
  defaultJobOptions,
});

const batchQueue = new Queue("podio-batches", {
  connection: createDuplicate(),
  defaultJobOptions,
});

const appQueue = new Queue("podio-app-events", {
  connection: createDuplicate(),
  defaultJobOptions,
});

const seedQueue = new Queue("podio-seed", {
  connection: createDuplicate(),
  defaultJobOptions,
});

module.exports = { flushQueue, batchQueue, appQueue, seedQueue, createDuplicate };
