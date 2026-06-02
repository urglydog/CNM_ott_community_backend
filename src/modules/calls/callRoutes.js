/**
 * Express route definitions for the call module.
 *
 * All routes are protected by JWT auth middleware.
 * Matches project convention: router + authMiddleware + controller handlers.
 */

const express = require("express");
const router = express.Router();
const authMiddleware = require("../../middlewares/authMiddleware");
const callController = require("./callController");

// ─── Recovery ───────────────────────────────────────────────────────────────

// Get user's current active/ringing call (crash/background recovery)
// MUST be before /:callId/* routes to avoid matching "active" as a callId
router.get("/active", authMiddleware, callController.getActiveCall);

// Dev helper: force-clean all blocking calls in a conversation
// MUST be before /:callId/* routes to avoid matching "dev" as a callId
router.post("/dev/cleanup/:conversationId", authMiddleware, callController.devCleanupConversation);

// Group call rebuild endpoints used by the current frontend.
// MUST be before /:callId/* routes to avoid matching "group" as a callId.
router.post("/group/initiate", authMiddleware, callController.initiateGroupCall);
router.post("/group/:sessionId/accept", authMiddleware, callController.acceptGroupCall);
router.post("/group/:sessionId/reject", authMiddleware, callController.rejectGroupCall);
router.post("/group/:sessionId/leave", authMiddleware, callController.leaveGroupCall);
router.post("/group/:sessionId/end", authMiddleware, callController.endGroupCall);
// Get active group call for a conversation (for "Join" button in chat)
router.get("/group/active", authMiddleware, callController.getActiveGroupCall);

// ─── Call Lifecycle ─────────────────────────────────────────────────────────

// Start a new call in a conversation
router.post("/start", authMiddleware, callController.startCall);

// Get a fresh Agora token for an active call
router.post("/:callId/token", authMiddleware, callController.getToken);

// Accept an incoming call
router.post("/:callId/accept", authMiddleware, callController.acceptCall);

// Reject an incoming call
router.post("/:callId/reject", authMiddleware, callController.rejectCall);

// Cancel a ringing call (initiator only)
router.post("/:callId/cancel", authMiddleware, callController.cancelCall);

// End an active call / leave group call
router.post("/:callId/end", authMiddleware, callController.endCall);

// ─── History ────────────────────────────────────────────────────────────────

// Get paginated call history for a conversation
router.get("/history/:conversationId", authMiddleware, callController.getHistory);

module.exports = router;
