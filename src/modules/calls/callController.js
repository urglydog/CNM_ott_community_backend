/**
 * REST API handlers for the call module.
 *
 * Thin layer — validates HTTP input, delegates to callService, formats HTTP response.
 *
 * IMPORTANT: Since the frontend uses REST endpoints (not socket events) for all
 * call actions, the controller must also emit socket events so that remote
 * participants receive real-time notifications.
 */

const callService = require("./callService");
const groupCallService = require("./groupCallService");
const groupCallRepo = require("./groupCallRepository");
const groupService = require("../groups/groupService");
const { CallError, validatePagination, encodeCursor } = require("./callValidation");
const { getIO } = require("../../socket/socketHandler");
const { emitToUserSockets, onlineUsers } = require("../../socket/socketUserRegistry");
const {
  buildPublicCallPayload,
  buildParticipantPayload,
  startRingTimer,
  cancelRingTimer,
  cancelAllRingTimers,
} = require("./callSocketHandler");
const {
  SOCKET_EVENTS,
  CALL_MODE,
  ENDED_REASON,
} = require("./call.constants");

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

// ── Socket emission helpers (mirror callSocketHandler logic for REST path) ──

/**
 * Emit a socket event to all call participants except the excluded user.
 * Mirrors callSocketHandler.emitToAllParticipants for the REST path.
 */
function emitToParticipants(io, callSession, eventName, payload, excludeUserId) {
  if (!io || !callSession?.participants) return;
  const participantIds = new Set(callSession.participants.map((p) => String(p.userId)));
  if (callSession.initiatorId) participantIds.add(String(callSession.initiatorId));

  for (const participantId of participantIds) {
    if (excludeUserId && participantId === String(excludeUserId)) continue;
    emitToUserSockets(io, participantId, eventName, payload);
  }
}

function getSocketCount(userId) {
  return onlineUsers.get(String(userId))?.size || 0;
}

function logGroupInviteStart(callSession, callerId, inviteeIds) {
  if (callSession.callMode !== CALL_MODE.GROUP) return;
  const memberIds = [
    ...new Set(callSession.participants.map((p) => String(p.userId))),
  ];
  console.log(`[GROUP_CALL_INVITE] sessionId=${callSession.callId}`);
  console.log(`[GROUP_CALL_INVITE] callerId=${callerId}`);
  console.log(`[GROUP_CALL_INVITE] groupId/conversationId=${callSession.conversationId}`);
  console.log(`[GROUP_CALL_INVITE] members=${JSON.stringify(memberIds)}`);
  console.log(`[GROUP_CALL_INVITE] invitees=${JSON.stringify(inviteeIds)}`);
}

function namespacedCallEvent(callSession, directEvent, groupEvent) {
  return callSession.callMode === CALL_MODE.GROUP ? groupEvent : directEvent;
}

function groupSessionPayload(joinPayload, callType = "video") {
  return {
    sessionId: joinPayload.sessionId,
    callId: joinPayload.sessionId,
    callType,
    channelName: joinPayload.channelName,
    agoraChannelName: joinPayload.channelName,
    token: joinPayload.token,
    agoraUid: joinPayload.uid,
    conversationId: joinPayload.conversationId,
  };
}

async function emitGroupToParticipants(sessionId, eventName, payload, excludeUserId) {
  const io = getIO();
  if (!io) return;

  const participants = await groupCallRepo.getParticipantsBySession(sessionId);
  for (const participant of participants) {
    if (excludeUserId && String(participant.userId) === String(excludeUserId)) continue;
    emitToUserSockets(io, participant.userId, eventName, payload);
  }
}

// ─── POST /api/calls/group/initiate ─────────────────────────────────────────

async function initiateGroupCall(req, res) {
  try {
    const userId = getUserId(req);
    const { conversationId, callType = "video" } = req.body || {};
    if (!userId || !conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }

    const members = await groupService.getGroupMembers(conversationId);
    const memberUserIds = [
      ...new Set([String(userId), ...members.map((m) => String(m.userId)).filter(Boolean)]),
    ];

    const result = await groupCallService.startGroupCall({
      conversationId,
      hostUserId: userId,
      memberUserIds,
    });

    const { session, hostJoinPayload, inviteeUserIds } = result;
    const io = getIO();
    if (io) {
      for (const inviteeId of inviteeUserIds) {
        console.log(
          `[GROUP_CALL_INCOMING_EMIT] userId=${inviteeId} socketCount=${getSocketCount(inviteeId)}`,
        );
        emitToUserSockets(io, inviteeId, "group-call:incoming", {
          sessionId: session.id,
          callId: session.id,
          callType,
          conversationId,
          channelName: session.channelName,
          hostUserId: String(userId),
          participants: result.participants,
        });
      }
    }

    return res.status(201).json({
      data: {
        call: {
          ...groupSessionPayload(hostJoinPayload, callType),
          participants: result.participants,
        },
      },
      message: "Group call initiated",
    });
  } catch (error) {
    console.error("[groupCall:initiate] Unexpected error:", error.message);
    return res.status(500).json({ message: error.message });
  }
}

// ─── POST /api/calls/group/:sessionId/accept ────────────────────────────────

async function acceptGroupCall(req, res) {
  try {
    const userId = getUserId(req);
    const { sessionId } = req.params;
    const joinPayload = await groupCallService.acceptGroupCall({ sessionId, userId });
    const session = groupSessionPayload(joinPayload, req.body?.callType || "video");

    await emitGroupToParticipants(
      sessionId,
      "group-call:participant-joined",
      {
        sessionId,
        joinedUserId: String(userId),
        userId: String(userId),
      },
      userId,
    );

    return res.json({
      data: { session },
      message: "Group call accepted",
    });
  } catch (error) {
    console.error("[groupCall:accept] Unexpected error:", error.message);
    return res.status(500).json({ message: error.message });
  }
}

async function rejectGroupCall(req, res) {
  try {
    const userId = getUserId(req);
    const { sessionId } = req.params;
    await groupCallService.rejectGroupCall({ sessionId, userId });
    await emitGroupToParticipants(
      sessionId,
      "group-call:participant-rejected",
      { sessionId, rejectedUserId: String(userId), userId: String(userId) },
      userId,
    );
    return res.json({ data: { rejected: true }, message: "Group call rejected" });
  } catch (error) {
    console.error("[groupCall:reject] Unexpected error:", error.message);
    return res.status(500).json({ message: error.message });
  }
}

async function leaveGroupCall(req, res) {
  try {
    const userId = getUserId(req);
    const { sessionId } = req.params;
    await groupCallService.leaveGroupCall({ sessionId, userId });
    await emitGroupToParticipants(
      sessionId,
      "group-call:participant-left",
      { sessionId, leftUserId: String(userId), userId: String(userId) },
      userId,
    );
    return res.json({ data: { ended: false }, message: "Left group call" });
  } catch (error) {
    console.error("[groupCall:leave] Unexpected error:", error.message);
    return res.status(500).json({ message: error.message });
  }
}

async function endGroupCall(req, res) {
  try {
    const userId = getUserId(req);
    const { sessionId } = req.params;
    const result = await groupCallService.endGroupCall({ sessionId, userId });
    await emitGroupToParticipants(sessionId, "group-call:ended", {
      sessionId,
      reason: result.reason,
    });
    return res.json({ data: { ended: true }, message: "Group call ended" });
  } catch (error) {
    console.error("[groupCall:end] Unexpected error:", error.message);
    return res.status(500).json({ message: error.message });
  }
}

// ─── POST /api/calls/start ──────────────────────────────────────────────────

/**
 * Start a new call in a conversation.
 * Body: { conversationId, callType }
 *
 * After creating the call, emits:
 *  - call:incoming  → each recipient (so they see the incoming call modal)
 *  - call:ringing   → the caller  (so caller sees "ringing…" state)
 *  Starts ring timers for timeout handling.
 */
async function startCall(req, res) {
  try {
    const userId = getUserId(req);
    const { conversationId, callType } = req.body;

    const result = await callService.startCall({ userId, conversationId, callType });
    const { callSession, tokenPayload, recipientIds } = result;
    const callId = callSession.callId;
    const eligibleRecipientIds = [
      ...new Set(
        callSession.participants
          .map((p) => String(p.userId))
          .filter((pid) => pid !== String(userId)),
      ),
    ];

    console.log(`[callController:startCall] callerId=${userId} recipientIds=${eligibleRecipientIds.join(",")} callId=${callId}`);

    // ── Emit socket events so receiver gets the incoming call popup ──────
    const io = getIO();
    if (io) {
      const publicPayload = buildPublicCallPayload(callSession);

      const incomingPayload = {
        callId,
        callSession: publicPayload,
        conversationId: callSession.conversationId,
        callMode: callSession.callMode,
        callType: callSession.callType,
        initiatorId: callSession.initiatorId,
        channelName: callSession.channelName,
        participants: callSession.participants.map(buildParticipantPayload),
        createdAt: callSession.createdAt,
      };

      logGroupInviteStart(callSession, userId, eligibleRecipientIds);
      let emittedCount = 0;
      const incomingEvent = namespacedCallEvent(
        callSession,
        SOCKET_EVENTS.DIRECT_CALL_INCOMING,
        SOCKET_EVENTS.GROUP_CALL_INCOMING,
      );

      for (const recipientId of eligibleRecipientIds) {
        const rKey = String(recipientId);
        if (callSession.callMode === CALL_MODE.GROUP) {
          console.log(`[GROUP_CALL_INVITE] emitting userId=${rKey} socketCount=${getSocketCount(rKey)}`);
        }
        console.log(`[callController:startCall] emitting ${incomingEvent} to ${rKey}`);
        if (emitToUserSockets(io, rKey, incomingEvent, incomingPayload)) {
          emittedCount += 1;
        }
      }

      if (callSession.callMode === CALL_MODE.GROUP) {
        console.log(`[GROUP_CALL_INVITE] emittedCount=${emittedCount}`);
      }

      // Notify caller that call is ringing
      emitToUserSockets(io, String(userId), SOCKET_EVENTS.CALL_RINGING, {
        callId,
        callSession: publicPayload,
      });

      // Start ring timer(s)
      if (callSession.callMode === CALL_MODE.DIRECT) {
        startRingTimer(io, callId, null, CALL_MODE.DIRECT);
      } else {
        for (const rid of eligibleRecipientIds) {
          startRingTimer(io, callId, rid, CALL_MODE.GROUP);
        }
      }
    } else {
      console.warn("[callController:startCall] getIO() returned null — socket events NOT emitted");
    }

    return res.status(201).json({
      call: callSession,
      token: tokenPayload,
      recipientIds: eligibleRecipientIds,
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
 * Emits call:accepted to all other participants so the caller transitions
 * from "outgoing" to "active".
 */
async function acceptCall(req, res) {
  try {
    const userId = getUserId(req);
    const { callId } = req.params;

    console.log(`[call:accept] userId=${userId} callId=${callId}`);
    const result = await callService.acceptCall({ userId, callId });
    const { callSession, tokenPayload } = result;

    const io = getIO();
    if (io) {
      // Cancel ring timer for this participant
      cancelRingTimer(callId, userId);

      console.log(`[call:accepted emit] callId=${callId} acceptedBy=${userId}`);
      // Notify all other participants that this user accepted
      emitToParticipants(io, callSession, namespacedCallEvent(
        callSession,
        SOCKET_EVENTS.DIRECT_CALL_ACCEPTED,
        SOCKET_EVENTS.GROUP_CALL_ACCEPTED,
      ), {
        callId,
        userId: String(userId),
        participant: buildParticipantPayload(
          callSession.participants.find((p) => String(p.userId) === String(userId)) || { userId },
        ),
        callSession: buildPublicCallPayload(callSession),
      }, userId);
    }

    return res.json({
      call: callSession,
      token: tokenPayload,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ─── POST /api/calls/:callId/reject ─────────────────────────────────────────

/**
 * Reject an incoming call.
 * Emits call:ended (if call ends) or call:rejected (group, partial) to participants.
 */
async function rejectCall(req, res) {
  try {
    const userId = getUserId(req);
    const { callId } = req.params;

    console.log(`[call:reject] userId=${userId} callId=${callId}`);
    const result = await callService.rejectCall({ userId, callId });
    const { ended, callSession } = result;

    const io = getIO();
    if (io) {
      if (ended) {
        cancelAllRingTimers(callId);
        console.log(`[call:ended emit] callId=${callId} reason=CALLEE_REJECTED endedBy=${userId}`);
        emitToParticipants(io, callSession, namespacedCallEvent(
          callSession,
          SOCKET_EVENTS.DIRECT_CALL_ENDED,
          SOCKET_EVENTS.GROUP_CALL_ENDED,
        ), {
          callId,
          endedBy: String(userId),
          reason: ENDED_REASON.CALLEE_REJECTED,
          callSession: buildPublicCallPayload(callSession),
        });
      } else {
        cancelRingTimer(callId, userId);
        console.log(`[call:rejected emit] callId=${callId} rejectedBy=${userId}`);
        emitToParticipants(io, callSession, namespacedCallEvent(
          callSession,
          SOCKET_EVENTS.DIRECT_CALL_REJECTED,
          SOCKET_EVENTS.GROUP_CALL_REJECTED,
        ), {
          callId,
          userId: String(userId),
          callSession: buildPublicCallPayload(callSession),
        });
      }
    }

    return res.json({
      ended: result.ended,
      call: callSession,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ─── POST /api/calls/:callId/cancel ─────────────────────────────────────────

/**
 * Cancel a ringing call (initiator only).
 * Emits call:cancelled to all participants.
 */
async function cancelCall(req, res) {
  try {
    const userId = getUserId(req);
    const { callId } = req.params;

    const result = await callService.cancelCall({ userId, callId });
    const { callSession } = result;

    const io = getIO();
    if (io) {
      cancelAllRingTimers(callId);

      console.log(`[call:cancel] Emitting call:cancelled to participants (excl. caller ${userId})`);
      emitToParticipants(io, callSession, namespacedCallEvent(
        callSession,
        SOCKET_EVENTS.DIRECT_CALL_ENDED,
        SOCKET_EVENTS.GROUP_CALL_ENDED,
      ), {
        callId,
        endedBy: String(userId),
        reason: ENDED_REASON.CALLER_CANCELLED,
        callSession: buildPublicCallPayload(callSession),
      }, String(userId));  // exclude caller — they already reset their store
    }

    return res.json({
      ended: result.ended,
      call: callSession,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// ─── POST /api/calls/:callId/end ────────────────────────────────────────────

/**
 * End an active call or leave a group call.
 * Emits call:ended or call:participant-left + call:state-updated to participants.
 */
async function endCall(req, res) {
  try {
    const userId = getUserId(req);
    const { callId } = req.params;
    const leaveOnly = req.body?.scope === "leave" || req.body?.leaveOnly === true;

    console.log(`[call:end] userId=${userId} callId=${callId} leaveOnly=${leaveOnly}`);
    const result = await callService.endCall({ userId, callId, leaveOnly });
    const { ended, selfOnly, callSession } = result;

    const io = getIO();
    if (io && !result.noop) {
      if (ended) {
        cancelAllRingTimers(callId);
        console.log(`[call:ended emit] callId=${callId} endedBy=${userId} reason=${callSession.endedReason || "USER_ENDED"}`);
        emitToParticipants(io, callSession, namespacedCallEvent(
          callSession,
          SOCKET_EVENTS.DIRECT_CALL_ENDED,
          SOCKET_EVENTS.GROUP_CALL_ENDED,
        ), {
          callId,
          endedBy: String(userId),
          reason: callSession.endedReason || ENDED_REASON.USER_ENDED,
          callSession: buildPublicCallPayload(callSession),
        });
      } else if (selfOnly) {
        cancelRingTimer(callId, userId);
        console.log(`[call:participant-left emit] callId=${callId} userId=${userId}`);
        emitToParticipants(io, callSession, SOCKET_EVENTS.GROUP_CALL_PARTICIPANT_LEFT, {
          callId,
          userId: String(userId),
          reason: "left",
          callSession: buildPublicCallPayload(callSession),
        });
        emitToParticipants(io, callSession, SOCKET_EVENTS.CALL_STATE_UPDATED, {
          callId,
          callSession: buildPublicCallPayload(callSession),
        });
      }
    }

    return res.json({
      ended: result.ended,
      selfOnly: selfOnly || false,
      call: callSession,
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

/**
 * Dev helper: Force-clean all blocking calls in a conversation.
 * POST /calls/dev/cleanup/:conversationId
 */
async function devCleanupConversation(req, res) {
  try {
    const { conversationId } = req.params;
    console.log(`[call:dev-cleanup] userId=${req.user?.userId} conversationId=${conversationId}`);
    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }
    const cleaned = await callService.cleanupConversationCalls(conversationId);
    return res.json({ cleaned, conversationId });
  } catch (error) {
    return handleError(res, error);
  }
}

module.exports = {
  initiateGroupCall,
  acceptGroupCall,
  rejectGroupCall,
  leaveGroupCall,
  endGroupCall,
  startCall,
  getToken,
  acceptCall,
  rejectCall,
  cancelCall,
  endCall,
  getHistory,
  getActiveCall,
  devCleanupConversation,
};
