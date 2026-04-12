const express = require("express");
const router = express.Router();

const messageController = require("./messageController");
const upload = require("../../common/middlewares/uploadMiddleware");

router.get(
  "/conversations/:conversationId",
  messageController.getMessagesForConversation,
);
// shortcut: lấy messages theo channelId, dùng conversationId dạng "channel:id"
router.get("/channel/:channelId", messageController.getMessagesForChannel);

router.post("/", messageController.sendMessage);
router.post("/file", upload.single("file"), messageController.sendFileMessage);

module.exports = router;
