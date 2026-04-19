const express = require("express");
const router = express.Router();

const authMiddleware = require("../../common/middlewares/authMiddleware");
const { revokeMessageHandler } = require("./messageRevokeController");

/**
 * PUT /api/messages-extension/revoke
 *
 * Revokes (soft-deletes) a message the authenticated user sent.
 *
 * Request body:
 *   { conversationId: string, messageId: string }
 *
 * Response 200:
 *   { success: true, message: "Message has been revoked", data: { conversationId, messageId, revokedAt, revokedBy } }
 *
 * Error responses:
 *   400 – missing or invalid fields
 *   401 – missing / invalid token
 *   403 – user is not the sender of the target message
 *   404 – conversation or message not found
 *   409 – message was already revoked
 */
router.put("/revoke", authMiddleware, revokeMessageHandler);

module.exports = router;
