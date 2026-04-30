const express = require("express");
const router = express.Router();

const messageController = require("./messageController");
const readReceiptController = require("./readReceiptController");
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
router.get("/search", authMiddleware, messageController.searchMessages);
router.get("/search/global", authMiddleware, messageController.searchMessagesGlobal);

router.post("/", messageController.sendMessage);
router.post("/file", upload.single("file"), messageController.sendFileMessage);
router.post("/sticker", messageController.sendStickerMessage);
router.post("/emoji", messageController.sendEmojiMessage);

// ─── Read Receipt Routes ───────────────────────────────────────────
router.get(
  "/read-receipts/:conversationId/:messageId",
  authMiddleware,
  readReceiptController.getReadReceiptsForMessage,
);
router.get(
  "/read-receipts/conversation/:conversationId",
  authMiddleware,
  readReceiptController.getReadStatusForMessages,
);
router.get(
  "/read-receipts/last-read/:conversationId",
  authMiddleware,
  readReceiptController.getLastReadPosition,
);
router.post(
  "/read-receipts",
  authMiddleware,
  readReceiptController.markAsRead,
);

module.exports = router;
