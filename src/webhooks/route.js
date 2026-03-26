const express = require("express");
const { handleWebhook } = require("./controller");

const router = express.Router();

router.route("/:appId").post(handleWebhook);

module.exports = router;
