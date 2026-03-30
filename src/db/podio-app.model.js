const mongoose = require("mongoose");

const podioAppSchema = mongoose.Schema(
  {
    appId: { type: Number, required: true, unique: true },
    appToken: { type: String, required: true },
    appName: { type: String, default: null },
    spaceId: { type: Number, default: null },
    isActive: { type: Boolean, default: true },
    webhookId: { type: Number, default: null },
    lastSeededAt: { type: Date, default: null },
  },
  { timestamps: true },
);

const PodioApp = mongoose.model("podio_app", podioAppSchema);
module.exports = PodioApp;
