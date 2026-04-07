const mongoose = require("mongoose");
const { softDelete } = require("./pluggins");

const appItemsSchema = mongoose.Schema(
  {
    appId: { type: Number, required: true },
    appName: { type: String, default: null },
    itemId: { type: Number, required: true },
    rawFields: { type: Map, of: mongoose.Schema.Types.Mixed, required: true },
    transformedFields: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      required: true,
    },
    appItemId: { type: Number, default: null },
    title: { type: String, default: null },
    createdOn: { type: Date, default: null },
    lastEventOn: { type: Date, default: null },
    syncStatus: {
      type: String,
      enum: ["success", "failed", "pending"],
      default: "pending",
    },
    lastSyncedAt: { type: Date, default: null },
    syncError: { type: String, default: null },
  },
  { timestamps: true },
);

appItemsSchema.index({ itemId: 1, appId: 1 }, { unique: true });
softDelete(appItemsSchema);

const AppItems = mongoose.model("app_items", appItemsSchema);
module.exports = AppItems;
