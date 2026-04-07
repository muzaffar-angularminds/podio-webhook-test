const mongoose = require("mongoose");

const stateSchema = mongoose.Schema(
  {
    appId: {
      type: String,
      required: true,
      unique: true,
    },
    pendingItems: [
      {
        itemId: { type: Number, required: true },
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

const State = mongoose.model("state", stateSchema);
module.exports = State;
