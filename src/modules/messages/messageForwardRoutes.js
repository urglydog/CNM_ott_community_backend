const express = require("express");
const router = express.Router();
const authMiddleware = require("../../common/middlewares/authMiddleware");
const messageForwardController = require("./messageForwardController");

/**
 * POST /api/messages-extension/forward
 *
 * Forwards an existing message to one or more target conversations.
 *
 * Protected: requires a valid Bearer token in the Authorization header.
 *
 * Request body:
 *   {
 *     originalMessageId   : string | number  (required)
 *     sourceConversationId: string           (required)
 *     targetConversationIds: string[]         (required)  max 20 items
 *   }
 *
 * Success response (200):
 *   {
 *     success: true,
 *     message: "Message forwarded successfully",
 *     data: {
 *       forwardedCount: number,
 *       results: [{ targetConversationId, forwardedMessage }],
 *       skipped: string[],
 *       errors: [{ targetConversationId, error }]   // only if some failed
 *     }
 *   }
 */
router.post("/forward", authMiddleware, messageForwardController.forwardMessage);

module.exports = router;
