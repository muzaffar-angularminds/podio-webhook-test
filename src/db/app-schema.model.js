const mongoose = require("mongoose");

const appSchemaModel = mongoose.Schema(
  {
    appId: { type: Number, required: true, unique: true },
    appName: { type: String, default: null },
    fields: { type: mongoose.Schema.Types.Mixed },
    fieldsHash: { type: String, default: null },
    previousFields: { type: mongoose.Schema.Types.Mixed, default: null },
    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

const AppSchema = mongoose.model("app_schema", appSchemaModel);
module.exports = AppSchema;
