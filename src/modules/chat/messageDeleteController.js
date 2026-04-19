const { deleteMessageForMe } = require("./messageDeleteService");

/**
 * DELETE /api/messages-extension/delete-for-me
 *
 * Hides a message from the authenticated user's view only.
 * The message remains visible to all other participants.
 *
 * URL params:
 *   :conversationId  – DynamoDB primary key (e.g. "channel:1" or "dm:1:2")
 *   :messageId       – The `id` of the target message
 *
 * Response 200:
 *   {
 *     success: true,
 *     message: "Message hidden from your view",
 *     data: { conversationId, messageId, deletedFor: string[], deletedForMeAt }
 *   }
 *
 * Error responses:
 *   400 – missing or invalid conversationId / messageId
 *   401 – missing / invalid token
 *   404 – conversation or message not found
 *   409 – user already deleted this message for themselves
 *   500 – unexpected server error
 */
async function deleteForMeController(req, res) {
  try {
    // ── 1. Extract authenticated user ───────────────────────────────────────
    const userId = req.user?.userId ?? req.user?.id ?? null;

    if (!userId) {
      return res.status(401).json({
        message: "Unauthorized: user identity could not be determined",
      });
    }

    // ── 2. Validate URL params ──────────────────────────────────────────────
    const { conversationId, messageId } = req.params;

    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }
    if (!messageId) {
      return res.status(400).json({ message: "messageId is required" });
    }

    // ── 3. Delegate to service ─────────────────────────────────────────────
    const result = await deleteMessageForMe(conversationId, messageId, userId);

    // ── 4. Respond ─────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: "Message hidden from your view",
      data: result,
    });
  } catch (error) {
    const errorCode = error.code ?? "INTERNAL_ERROR";

    switch (errorCode) {
      case "BAD_REQUEST":
        return res.status(400).json({ message: error.message });

      case "NOT_FOUND":
        return res.status(404).json({ message: error.message });

      case "MESSAGE_NOT_FOUND":
        return res.status(404).json({ message: error.message });

      case "ALREADY_DELETED_FOR_ME":
        return res.status(409).json({ message: error.message });

      default:
        console.error("[messageDeleteController] Unexpected error:", error);
        return res.status(500).json({
          message: "An unexpected error occurred while deleting the message for you",
        });
    }
  }
}

module.exports = { deleteForMeController };
