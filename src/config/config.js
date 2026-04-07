const dotenv = require("dotenv");
const path = require("path");
const Joi = require("joi");

dotenv.config({ path: path.join(__dirname, "../../.env") });

const envVarsSchema = Joi.object({
  NODE_ENV: Joi.string().valid("production", "development", "test").required(),
  PORT: Joi.number().required(),
  MONGODB_URL: Joi.string().required(),
  PODIO_CLIENT_ID: Joi.string().required(),
  PODIO_CLIENT_SECRET: Joi.string().required(),
  PODIO_WEBHOOK_SECRET: Joi.string().required(),
  REDIS_URL: Joi.string().default("redis://localhost:6379"),
  FLUSH_DELAY_MS: Joi.number().default(120000),
  HEARTBEAT_INTERVAL_MS: Joi.number().default(3600000),
  BATCH_SIZE: Joi.number().default(500),
  SEED_DELAY_MS: Joi.number().default(18000),
}).unknown();

const { value: envVars, error } = envVarsSchema.validate(process.env, {
  errors: { label: "key" },
});

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

module.exports = {
  NODE_ENV: envVars.NODE_ENV,
  PORT: envVars.PORT,
  MONGODB_URL: envVars.MONGODB_URL,
  PODIO_CLIENT_ID: envVars.PODIO_CLIENT_ID,
  PODIO_CLIENT_SECRET: envVars.PODIO_CLIENT_SECRET,
  PODIO_WEBHOOK_SECRET: envVars.PODIO_WEBHOOK_SECRET,
  REDIS_URL: envVars.REDIS_URL,
  FLUSH_DELAY_MS: envVars.FLUSH_DELAY_MS,
  HEARTBEAT_INTERVAL_MS: envVars.HEARTBEAT_INTERVAL_MS,
  BATCH_SIZE: envVars.BATCH_SIZE,
  SEED_DELAY_MS: envVars.SEED_DELAY_MS,
};
