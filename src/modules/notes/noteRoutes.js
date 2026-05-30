const express = require("express");

const authMiddleware = require("../../common/middlewares/authMiddleware");
const noteController = require("./noteController");

const router = express.Router();

router.use(authMiddleware);

router.post("/", noteController.createNote);

module.exports = router;
