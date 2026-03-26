const mongoose = require("mongoose");

const podioItemSchema = mongoose.Schema(
  {
    app_id: { type: Number, required: true },
    item_id: { type: Number, required: true },
    data: { type: mongoose.Schema.Types.Mixed },
    title: { type: String, default: null },
    podio_last_updated_at: { type: Date, default: null },
    sync_status: {
      type: String,
      enum: ["success", "failed", "pending"],
      default: "pending",
    },
    last_synced_at: { type: Date, default: null },
    sync_error: { type: String, default: null },
  },
  { timestamps: true },
);

podioItemSchema.index({ item_id: 1, app_id: 1 }, { unique: true });

const PodioItem = mongoose.model("podio_item", podioItemSchema);
module.exports = PodioItem;
