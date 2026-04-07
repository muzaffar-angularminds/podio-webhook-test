const mongoose = require("mongoose");

const changesSchema = mongoose.Schema(
  {
    type: { type: String, required: true },
    fieldId: { type: Number },
    externalId: { type: String, default: null },
    label: { type: String, default: null },
    from: { type: String, default: null },
    to: { type: String, default: null },
  },
  { _id: false },
);

const appSchemaLogsSchema = mongoose.Schema(
  {
    appId: { type: Number, required: true, index: true },
    appName: { type: String, default: null },
    changes: [{ type: changesSchema }],
    detectedAt: { type: Date, default: Date.now },
    triggeredReseed: { type: Boolean, default: false },
    reseedResult: {
      type: String,
      enum: ["success", "failed", null],
      default: null,
    },
    reseedError: { type: String, default: null },
    fieldsHashBefore: { type: String, default: null },
    fieldsHashAfter: { type: String, default: null },
  },
  { timestamps: true },
);

appSchemaLogsSchema.index({ createdAt: -1 });

const AppSchemaLogs = mongoose.model("app_schema_logs", appSchemaLogsSchema);
module.exports = AppSchemaLogs;
