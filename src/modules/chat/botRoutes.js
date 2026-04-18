const express = require("express");
const { chatWithBot } = require("./botController");

const router = express.Router();

router.post("/chat", chatWithBot);

module.exports = router;
