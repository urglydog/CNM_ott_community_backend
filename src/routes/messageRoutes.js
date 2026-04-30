const express = require("express");
const router = express.Router();

const messageController = require('../modules/messages/messageController');

router.get(
  "/conversations/:conversationId",
  messageController.getMessagesForConversation,
);
// shortcut: lấy messages theo channelId, dùng conversationId dạng "channel:id"
router.get("/channel/:channelId", messageController.getMessagesForChannel);

router.post("/", messageController.sendMessage);
router.post("/channel", messageController.sendChannelMessage);
router.post("/direct", messageController.sendDirectMessage);

module.exports = router;
