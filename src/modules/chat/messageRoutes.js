const express = require("express");
const router = express.Router();

const messageController = require("./messageController");
const authMiddleware = require("../../common/middlewares/authMiddleware");
const upload = require("../../common/middlewares/uploadMiddleware");

// All message read routes require authentication so the service can filter
// messages hidden by the current user (deleted-for-me).
router.get(
  "/conversations/:conversationId",
  authMiddleware,
  messageController.getMessagesForConversation,
);
// shortcut: lấy messages theo channelId, dùng conversationId dạng "channel:id"
router.get("/channel/:channelId", authMiddleware, messageController.getMessagesForChannel);

router.post("/", messageController.sendMessage);
router.post("/file", upload.single("file"), messageController.sendFileMessage);

module.exports = router;
