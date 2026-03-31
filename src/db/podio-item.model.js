const mongoose = require("mongoose");
const { softDelete } = require("./pluggins");

const podioItemSchema = mongoose.Schema(
  {
    appId: { type: Number, required: true },
    itemId: { type: Number, required: true },
    data: { type: mongoose.Schema.Types.Mixed },
    appItemId: { type: Number, default: null },
    title: { type: String, default: null },
    podioCreatedOn: { type: Date, default: null },
    podioLastEventOn: { type: Date, default: null },
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

podioItemSchema.index({ itemId: 1, appId: 1 }, { unique: true });
softDelete(podioItemSchema);

const PodioItem = mongoose.model("podio_item", podioItemSchema);
module.exports = PodioItem;
