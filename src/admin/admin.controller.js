const path = require("path");
const PodioApp = require("../db/podio-app.model");
const { clearAppCredentialCache } = require("../webhooks/client");
const catchAsync = require("../utils/catchAsync");
const logger = require("../config/logger");

const servePage = (req, res) => {
  res.sendFile(path.join(__dirname, "views", "apps.html"));
};

const listApps = catchAsync(async (req, res) => {
  const apps = await PodioApp.find({}).sort({ createdAt: -1 });
  res.set("Cache-Control", "no-store");
  res.json(apps);
});

const addApp = catchAsync(async (req, res) => {
  const { appId, appToken, appName, spaceId } = req.body;

  if (!appId || !appToken) {
    return res.status(400).json({ message: "appId and appToken are required" });
  }

  const existing = await PodioApp.findOne({ appId: Number(appId) });
  if (existing) {
    return res.status(409).json({ message: `App ${appId} already exists` });
  }

  const app = await PodioApp.create({
    appId: Number(appId),
    appToken,
    appName: appName || null,
    spaceId: spaceId ? Number(spaceId) : null,
  });

  logger.info(`[Admin] App ${appId} registered: ${appName || "unnamed"}`);
  res.status(201).json(app);
});

const toggleApp = catchAsync(async (req, res) => {
  const { appId } = req.params;
  const app = await PodioApp.findOne({ appId: Number(appId) });

  if (!app) {
    return res.status(404).json({ message: `App ${appId} not found` });
  }

  app.isActive = !app.isActive;
  await app.save();

  clearAppCredentialCache(appId);
  logger.info(`[Admin] App ${appId} ${app.isActive ? "activated" : "deactivated"}`);
  res.json(app);
});

const deleteApp = catchAsync(async (req, res) => {
  const { appId } = req.params;
  const app = await PodioApp.findOneAndDelete({ appId: Number(appId) });

  if (!app) {
    return res.status(404).json({ message: `App ${appId} not found` });
  }

  clearAppCredentialCache(appId);
  logger.info(`[Admin] App ${appId} deleted`);
  res.json({ message: `App ${appId} deleted` });
});

module.exports = { servePage, listApps, addApp, toggleApp, deleteApp };
