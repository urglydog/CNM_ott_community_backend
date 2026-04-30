const messageForwardService = require("./messageForwardService");

/**
 * POST /api/messages-extension/forward
 *
 * Forwards a message from a source conversation to one or more target conversations.
 *
 * Request body:
 *   {
 *     originalMessageId  : string | number  (required) — id of the message to forward
 *     sourceConversationId: string           (required) — PK of the source conversation
 *     targetConversationIds: string[]        (required) — destination PK(s)
 *   }
 *
 * Response (200):
 *   {
 *     success: true,
 *     message: "Message forwarded successfully",
 *     data: {
 *       forwardedCount : number,    // how many destinations succeeded
 *       results: [
 *         {
 *           targetConversationId: string,
 *           forwardedMessage: {
 *             id, senderId, content, contentType, attachments,
 *             isForwarded, originalSenderId, originalMessageId,
 *             originalConversationId, createdAt,
 *             senderDisplayName, senderAvatarUrl
 *           }
 *         }
 *       ],
 *       skipped: string[]           // target conversation IDs that were not found
 *     }
 *   }
 *
 * Error codes:
 *   400 — BAD_REQUEST          (missing / malformed parameters)
 *   404 — SOURCE_NOT_FOUND     (source conversation not in DB)
 *   404 — MESSAGE_NOT_FOUND   (original message not found)
 *   500 — INTERNAL_ERROR      (database or unexpected error)
 */
async function forwardMessage(req, res) {
  const userId = req.user?.userId ?? req.user?.id ?? null;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: userId not found in token",
    });
  }

  const { originalMessageId, sourceConversationId, targetConversationIds } = req.body;

  // ── Body validation ────────────────────────────────────────────────────────
  if (!originalMessageId) {
    return res.status(400).json({
      success: false,
      message: "originalMessageId is required",
      code: "BAD_REQUEST",
    });
  }

  if (!sourceConversationId) {
    return res.status(400).json({
      success: false,
      message: "sourceConversationId is required",
      code: "BAD_REQUEST",
    });
  }

  if (!Array.isArray(targetConversationIds) || targetConversationIds.length === 0) {
    return res.status(400).json({
      success: false,
      message: "targetConversationIds must be a non-empty array",
      code: "BAD_REQUEST",
    });
  }

  // Sanity limit to prevent abuse / unbounded DB writes
  if (targetConversationIds.length > 20) {
    return res.status(400).json({
      success: false,
      message: "Cannot forward to more than 20 destinations at once",
      code: "BAD_REQUEST",
    });
  }

  try {
    const { results, skipped, errors } = await messageForwardService.forwardMessage({
      originalMessageId,
      sourceConversationId,
      targetConversationIds,
      senderId: userId,
    });

    // ── Socket.io: broadcast receive_message to every target conversation ───
    const io = req.app.get("socketio");

    for (const { targetConversationId, forwardedMessage } of results) {
      io.to(targetConversationId).emit("receive_message", {
        type: "forwarded",
        message: forwardedMessage,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Message forwarded successfully",
      data: {
        forwardedCount: results.length,
        results,
        skipped,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (error) {
    console.error("[messageForwardController] forwardMessage error:", error);

    const statusMap = {
      BAD_REQUEST: 400,
      SOURCE_NOT_FOUND: 404,
      MESSAGE_NOT_FOUND: 404,
      INTERNAL_ERROR: 500,
    };

    const status = statusMap[error.code] || 500;

    return res.status(status).json({
      success: false,
      message: error.message,
      code: error.code || "INTERNAL_ERROR",
    });
  }
}

module.exports = { forwardMessage };
