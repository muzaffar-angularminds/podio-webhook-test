const mongoose = require("mongoose");

const webhookStateSchema = mongoose.Schema(
  {
    // We use appId as the unique key to group items
    appId: {
      type: String,
      required: true,
      unique: true,
    },
    // This stores the array of pending item objects
    pendingItems: [
      {
        itemId: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    lastSyncAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

const WebhookState = mongoose.model("webhook_state", webhookStateSchema);
module.exports = WebhookState;
