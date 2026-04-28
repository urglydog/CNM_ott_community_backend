const express = require("express");
const router = express.Router();

const authMiddleware = require("../../common/middlewares/authMiddleware");
const { deleteForMeController } = require("./messageDeleteController");

/**
 * DELETE /api/messages-extension/delete-for-me/:conversationId/:messageId
 *
 * Hides a specific message from the authenticated user's view only.
 * The message remains in the database and is still visible to other participants.
 *
 * URL params:
 *   :conversationId  – DynamoDB primary key (e.g. "channel:1" or "dm:1:2")
 *   :messageId        – The `id` field of the message to hide
 *
 * Response 200:
 *   {
 *     success: true,
 *     message: "Message hidden from your view",
 *     data: { conversationId, messageId, deletedFor: string[], deletedForMeAt }
 *   }
 *
 * Error responses:
 *   400 – missing or invalid fields
 *   401 – missing / invalid token
 *   404 – conversation or message not found
 *   409 – message was already deleted for this user
 *   500 – unexpected server error
 */
router.delete("/delete-for-me/:conversationId/:messageId", authMiddleware, deleteForMeController);

module.exports = router;
