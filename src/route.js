const express = require("express");
const router = express.Router();
const config = require("./config/config");

// const docsRoute = require("./docs/docs.route");

//main routes
const webhookRoute = require("./webhooks/route");

// Routes index
const defaultRoutes = [
  {
    path: "/webhooks/podio",
    route: webhookRoute,
  },
  //   {
  //     path: "/users",
  //     route: userRoute,
  //   },
];

//Swagger documentation route available only in development mode
const devRoutes = [
  //   {
  //     path: "/docs",
  //     route: docsRoute,
  //   },
];

defaultRoutes.forEach((route) => {
  router.use(`${route.path}`, route.route);
});

/* istanbul ignore next */
if (config.NODE_ENV === "development") {
  devRoutes.forEach((route) => {
    router.use(`${route.path}`, route.route);
  });
}

router.get("/status", (req, res) => {
  res.sendStatus(200);
});

module.exports = router;
