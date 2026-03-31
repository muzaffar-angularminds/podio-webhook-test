const express = require("express");
const path = require("path");
const {
  servePage,
  listApps,
  addApp,
  toggleApp,
  deleteApp,
} = require("./admin.controller");

const router = express.Router();

// Serve static JS for admin pages
router.use("/views", express.static(path.join(__dirname, "views")));

// HTML page
router.get("/apps", servePage);

// JSON API
router.get("/api/apps", listApps);
router.post("/api/apps", addApp);
router.patch("/api/apps/:appId/toggle", toggleApp);
router.delete("/api/apps/:appId", deleteApp);

module.exports = router;
