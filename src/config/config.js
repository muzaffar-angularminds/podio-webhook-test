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
  PODIO_APP_ID: Joi.string().required(),
  PODIO_APP_TOKEN: Joi.string().required(),
  PODIO_WEBHOOK_SECRET: Joi.string().required(),
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
  PODIO_APP_ID: envVars.PODIO_APP_ID,
  PODIO_APP_TOKEN: envVars.PODIO_APP_TOKEN,
  PODIO_WEBHOOK_SECRET: envVars.PODIO_WEBHOOK_SECRET,
};
