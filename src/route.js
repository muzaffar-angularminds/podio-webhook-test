const express = require("express");
const router = express.Router();
const config = require("./config/config");

const webhookRoute = require("./webhooks/route");
const adminRoute = require("./admin/admin.route");

const defaultRoutes = [
  {
    path: "/webhooks/podio",
    route: webhookRoute,
  },
  {
    path: "/admin",
    route: adminRoute,
  },
];

const devRoutes = [];

defaultRoutes.forEach((route) => {
  router.use(`${route.path}`, route.route);
});

if (config.NODE_ENV === "development") {
  devRoutes.forEach((route) => {
    router.use(`${route.path}`, route.route);
  });
}

router.get("/status", (req, res) => {
  res.sendStatus(200);
});

module.exports = router;
