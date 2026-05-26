/**
 * REST API handlers for the call module.
 *
 * Thin layer — validates HTTP input, delegates to callService, formats HTTP response.
 * No business logic lives here.
 */

const callService = require("./callService");
const { CallError, validatePagination, encodeCursor } = require("./callValidation");

/**
 * Extract userId from the authenticated request.
 * Compatible with both req.user.userId and req.user.id patterns.
 *
 * @param {Object} req - Express request
 * @returns {string}
 */
function getUserId(req) {
  return req.user?.userId || req.user?.id;
}

/**
 * Unified error handler for call endpoints.
 * CallError instances get their statusCode and code; others default to 500.
 */
function handleError(res, error) {
  if (error instanceof CallError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
    });
  }
  console.error("[callController] Unexpected error:", error.message);
  return res.status(500).json({
    error: "Internal server error",
    code: "INTERNAL_ERROR",
  });
}

// ─── POST /api/calls/start ──────────────────────────────────────────────────

/**
 * Start a new call in a conversation.
 * Body: { conversationId, callType }
 */
async function startCall(req, res) {
  try {
    const userId = getUserId(req);
    const { conversationId, callType } = req.body;

    const result = await callService.startCall({ userId, conversationId, callType });

    return res.status(201).json({
      call: result.callSession,
      token: result.tokenPayload,
      recipientIds: result.recipientIds,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ─── POST /api/calls/:callId/token ──────────────────────────────────────────

/**
 * Get a fresh Agora token for an active call.
 */
async function getToken(req, res) {
  try {
    const userId = getUserId(req);
    const { callId } = req.params;

    const tokenPayload = await callService.getCallToken({ userId, callId });

    return res.json(tokenPayload);
  } catch (error) {
    return handleError(res, error);
  }
}

// ─── POST /api/calls/:callId/accept ─────────────────────────────────────────

/**
 * Accept an incoming call.
 */
async function acceptCall(req, res) {
  try {
    const userId = getUserId(req);
    const { callId } = req.params;

    const result = await callService.acceptCall({ userId, callId });

    return res.json({
      call: result.callSession,
      token: result.tokenPayload,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ─── POST /api/calls/:callId/reject ─────────────────────────────────────────

/**
 * Reject an incoming call.
 */
async function rejectCall(req, res) {
  try {
    const userId = getUserId(req);
    const { callId } = req.params;

    const result = await callService.rejectCall({ userId, callId });

    return res.json({
      ended: result.ended,
      call: result.callSession,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ─── POST /api/calls/:callId/cancel ─────────────────────────────────────────

/**
 * Cancel a ringing call (initiator only).
 */
async function cancelCall(req, res) {
  try {
    const userId = getUserId(req);
    const { callId } = req.params;

    const result = await callService.cancelCall({ userId, callId });

    return res.json({
      ended: result.ended,
      call: result.callSession,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ─── POST /api/calls/:callId/end ────────────────────────────────────────────

/**
 * End an active call or leave a group call.
 */
async function endCall(req, res) {
  try {
    const userId = getUserId(req);
    const { callId } = req.params;

    const result = await callService.endCall({ userId, callId });

    return res.json({
      ended: result.ended,
      selfOnly: result.selfOnly || false,
      call: result.callSession,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ─── GET /api/calls/history/:conversationId ─────────────────────────────────

/**
 * Get call history for a conversation.
 * Query params: ?limit=20&cursor=base64encoded
 */
async function getHistory(req, res) {
  try {
    const userId = getUserId(req);
    const { conversationId } = req.params;
    const pagination = validatePagination(req.query);

    const result = await callService.getHistory({
      userId,
      conversationId,
      pagination,
    });

    return res.json({
      items: result.items,
      nextCursor: result.nextCursor || null,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ─── GET /api/calls/active ──────────────────────────────────────────────────

/**
 * Get the user's current active or ringing call.
 * Used for crash recovery / background recovery.
 * Returns the call session + fresh token if joinable.
 */
async function getActiveCall(req, res) {
  try {
    const userId = getUserId(req);
    const result = await callService.getActiveCall(userId);

    if (!result.callSession) {
      return res.json({ call: null, token: null });
    }

    return res.json({
      call: result.callSession,
      token: result.tokenPayload || null,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

module.exports = {
  startCall,
  getToken,
  acceptCall,
  rejectCall,
  cancelCall,
  endCall,
  getHistory,
  getActiveCall,
};
