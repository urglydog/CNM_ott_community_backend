/**
 * Socket.IO handler for video/voice call signaling.
 *
 * Architecture:
 *   - Delegates ALL business logic to callService (no direct DB calls here).
 *   - Delegates ALL provider/token logic to callService (no Agora imports here).
 *   - Manages in-memory timers for ringing timeout and reconnect grace period.
 *   - Uses provider-neutral event names from SOCKET_EVENTS.
 *   - Multi-device sync: emits to ALL sockets for a target user.
 *   - Token privacy: NEVER broadcasts Agora tokens in socket payloads.
 *
 * Timer maps:
 *   activeRingTimers    : Map<key, Timeout>  — key = callId (direct) or callId:userId (group)
 *   reconnectGraceTimers: Map<"callId:userId", Timeout> — reconnect grace (15s)
 */

const callService = require("./callService");
const callModel = require("./callModel");
const { emitToUserSockets: emitToUserSocketsRegistry, onlineUsers } = require("../../socket/socketUserRegistry");
const {
  SOCKET_EVENTS,
  CALL_STATUS,
  CALL_MODE,
  CALL_TYPE,
  PARTICIPANT_STATUS,
  ENDED_REASON,
  TIMEOUTS,
} = require("./call.constants");

// ─── In-memory timer maps (not persisted) ─────────────────────────────────

/** @type {Map<string, NodeJS.Timeout>} key → ringing timeout. Key = callId (direct) or callId:userId (group) */
const activeRingTimers = new Map();

/** @type {Map<string, NodeJS.Timeout>} "callId:userId" → reconnect grace timeout */
const reconnectGraceTimers = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Build a safe public payload from a callSession (strips tokens, internal fields).
 * @param {Object} callSession
 * @returns {Object}
 */
function buildPublicCallPayload(callSession) {
  return {
    callId: callSession.callId,
    conversationId: callSession.conversationId,
    initiatorId: callSession.initiatorId,
    callMode: callSession.callMode,
    callType: callSession.callType,
    status: callSession.status,
    channelName: callSession.channelName,
    participants: callSession.participants.map((p) => ({
      userId: p.userId,
      role: p.role,
      status: p.status,
      connectionState: p.connectionState || "connected",
      joinedAt: p.joinedAt || null,
      leftAt: p.leftAt || null,
    })),
    startedAt: callSession.startedAt || null,
    endedAt: callSession.endedAt || null,
    endedReason: callSession.endedReason || null,
    createdAt: callSession.createdAt,
  };
}

/**
 * Build a compact participant payload (no token).
 * @param {Object} participant
 * @returns {Object}
 */
function buildParticipantPayload(participant) {
  return {
    userId: participant.userId,
    role: participant.role,
    status: participant.status,
    connectionState: participant.connectionState || "connected",
    joinedAt: participant.joinedAt || null,
    leftAt: participant.leftAt || null,
  };
}

/**
 * Emit an event to ALL sockets of a specific user (multi-device sync).
 * @param {Object} io - Socket.IO server instance
 * @param {string|number} userId
 * @param {string} eventName
 * @param {Object} payload
 */
function emitToUser(io, userId, eventName, payload) {
  emitToUserSocketsRegistry(io, userId, eventName, payload);
}

/**
 * Emit an event to ALL sockets of ALL participants in a call session.
 * @param {Object} io
 * @param {Object} callSession
 * @param {string} eventName
 * @param {Object} payload
 * @param {string} [excludeUserId] - Optional user to exclude
 */
function emitToAllParticipants(io, callSession, eventName, payload, excludeUserId) {
  const participantIds = callSession.participants.map((p) => p.userId);
  // Also include initiator if not in participants array (shouldn't happen, but safety)
  if (!participantIds.includes(callSession.initiatorId)) {
    participantIds.push(callSession.initiatorId);
  }

  for (const pid of participantIds) {
    if (excludeUserId && String(pid) === String(excludeUserId)) continue;
    emitToUser(io, pid, eventName, payload);
  }
}

// ─── Ring Timer Management (Fix 4: per-participant for group calls) ───────

/**
 * Build the ring timer key.
 * Direct calls: key = callId (one timer for the whole call)
 * Group calls:  key = callId:userId (per-participant timer)
 */
function ringTimerKey(callId, userId) {
  return userId ? `${callId}:${userId}` : callId;
}

/**
 * Start the ringing timeout.
 * @param {Object} io
 * @param {string} callId
 * @param {string} [userId] - For group calls, the specific participant
 * @param {string} [callMode] - CALL_MODE.DIRECT or CALL_MODE.GROUP
 * @param {number} [timeoutMs] - Override timeout (used by recovery for remaining time)
 */
function startRingTimer(io, callId, userId, callMode, timeoutMs) {
  const key = ringTimerKey(callId, userId);
  if (activeRingTimers.has(key)) return;

  const timer = setTimeout(async () => {
    activeRingTimers.delete(key);

    try {
      let result;
      if (callMode === CALL_MODE.GROUP && userId) {
        // Group: timeout single participant
        result = await callService.timeoutParticipant(callId, userId);
      } else {
        // Direct: timeout the entire call
        result = await callService.timeoutRingCall(callId);
      }

      const { ended, callSession, missedUserIds } = result;

      // Notify missed users individually
      for (const missedId of missedUserIds) {
        emitToUser(io, missedId, SOCKET_EVENTS.CALL_MISSED, {
          callId,
          reason: "no_answer",
        });
      }

      if (ended) {
        // Broadcast call ended to all participants
        emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_ENDED, {
          callId,
          endedBy: null,
          reason: ENDED_REASON.NO_ANSWER_TIMEOUT,
          callSession: buildPublicCallPayload(callSession),
        });
      } else if (missedUserIds.length > 0) {
        // Group call continues — broadcast updated state
        emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_STATE_UPDATED, {
          callId,
          callSession: buildPublicCallPayload(callSession),
        });
      }
    } catch (err) {
      console.error(`[call-socket] Ring timeout handler error for ${key}:`, err.message);
    }
  }, timeoutMs || TIMEOUTS.RING_TIMEOUT_MS);

  activeRingTimers.set(key, timer);
}

/**
 * Cancel a specific ring timer.
 * @param {string} callId
 * @param {string} [userId] - For group calls, the specific participant
 */
function cancelRingTimer(callId, userId) {
  const key = ringTimerKey(callId, userId);
  const timer = activeRingTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    activeRingTimers.delete(key);
  }
}

/**
 * Cancel ALL ring timers for a call (used when call ends/cancels).
 * @param {string} callId
 */
function cancelAllRingTimers(callId) {
  // Cancel direct-call timer (key = callId)
  const directTimer = activeRingTimers.get(callId);
  if (directTimer) {
    clearTimeout(directTimer);
    activeRingTimers.delete(callId);
  }
  // Cancel all per-participant timers (key = callId:userId)
  const prefix = `${callId}:`;
  for (const [key, timer] of activeRingTimers.entries()) {
    if (key.startsWith(prefix)) {
      clearTimeout(timer);
      activeRingTimers.delete(key);
    }
  }
}

// ─── Reconnect Grace Timer Management ─────────────────────────────────────

/**
 * Start the reconnect grace timer for a participant (15s).
 * @param {Object} io
 * @param {string} callId
 * @param {string} userId
 * @param {number} [timeoutMs] - Override timeout (used by recovery for remaining time)
 */
function startReconnectTimer(io, callId, userId, timeoutMs) {
  const key = `${callId}:${userId}`;
  if (reconnectGraceTimers.has(key)) return;

  const timer = setTimeout(async () => {
    reconnectGraceTimers.delete(key);

    try {
      const result = await callService.endCallDueToDisconnect(callId, userId);
      const { ended, callSession } = result;

      if (ended) {
        // Call ended due to disconnect timeout
        cancelAllRingTimers(callId);

        emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_ENDED, {
          callId,
          endedBy: userId,
          reason: ENDED_REASON.DISCONNECT_TIMEOUT,
          callSession: buildPublicCallPayload(callSession),
        });
      } else {
        // Group call: participant left but call continues
        emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_PARTICIPANT_LEFT, {
          callId,
          userId,
          reason: "disconnect_timeout",
          callSession: buildPublicCallPayload(callSession),
        });

        // Also send state update
        emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_STATE_UPDATED, {
          callId,
          callSession: buildPublicCallPayload(callSession),
        });
      }
    } catch (err) {
      console.error(`[call-socket] Reconnect timeout error for ${callId}:${userId}:`, err.message);
    }
  }, timeoutMs || TIMEOUTS.RECONNECT_GRACE_MS);

  reconnectGraceTimers.set(key, timer);
}

/**
 * Cancel the reconnect grace timer for a participant.
 * @param {string} callId
 * @param {string} userId
 */
function cancelReconnectTimer(callId, userId) {
  const key = `${callId}:${userId}`;
  const timer = reconnectGraceTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    reconnectGraceTimers.delete(key);
  }
}

/**
 * Cleanup all reconnect timers for a call.
 * @param {string} callId
 */
function cancelAllReconnectTimers(callId) {
  const prefix = `${callId}:`;
  for (const [key, timer] of reconnectGraceTimers.entries()) {
    if (key.startsWith(prefix)) {
      clearTimeout(timer);
      reconnectGraceTimers.delete(key);
    }
  }
}

// ─── Error/Success Helpers ────────────────────────────────────────────────

/**
 * Send error via callback ack or emit call:error event.
 * @param {Object} socket
 * @param {Function|undefined} callback
 * @param {string} code - Machine-readable error code
 * @param {string} message - Human-readable message
 */
function sendError(socket, callback, code, message) {
  if (typeof callback === "function") {
    callback({ ok: false, error: { code, message } });
  } else {
    socket.emit(SOCKET_EVENTS.CALL_ERROR, { code, message });
  }
}

/**
 * Send success via callback ack.
 * @param {Function|undefined} callback
 * @param {Object} [extra] - Additional fields
 */
function sendOk(callback, extra = {}) {
  if (typeof callback === "function") {
    callback({ ok: true, ...extra });
  }
}

// ─── Event Handlers ───────────────────────────────────────────────────────

/**
 * Handle call:start — initiate a new call.
 */
async function handleCallStart(io, socket, userId, data, callback) {
  try {
    const { conversationId, callType } = data || {};

    const result = await callService.startCall({
      userId,
      conversationId,
      callType,
    });

    const { callSession, tokenPayload, recipientIds } = result;
    const callId = callSession.callId;

    // Join initiator to a call-specific room for easy broadcasting
    socket.join(`call:${callId}`);

    // Send token ONLY to initiator (via ack)
    sendOk(callback, {
      callId,
      token: tokenPayload.token,
      uid: tokenPayload.uid,
      channelName: tokenPayload.channelName,
    });

    // Notify all recipients about incoming call (NO token in payload)
    const incomingPayload = {
      callId,
      conversationId: callSession.conversationId,
      callMode: callSession.callMode,
      callType: callSession.callType,
      initiatorId: callSession.initiatorId,
      channelName: callSession.channelName,
      participants: callSession.participants.map(buildParticipantPayload),
      createdAt: callSession.createdAt,
    };

    for (const recipientId of recipientIds) {
      // Check if recipient is online
      const recipientKey = String(recipientId);
      const recipientSockets = onlineUsers.get(recipientKey);
      if (recipientSockets && recipientSockets.size > 0) {
        emitToUser(io, recipientId, SOCKET_EVENTS.CALL_INCOMING, incomingPayload);
      } else {
        // Recipient offline → mark as missed immediately
        // (Don't await, fire-and-forget for now)
        const callRepository = require("./callRepository");
        callRepository.updateParticipant(callId, recipientId, {
          status: PARTICIPANT_STATUS.MISSED,
        }).catch((err) => {
          console.error(`[call-socket] Failed to mark offline recipient ${recipientId} as missed:`, err.message);
        });
      }
    }

    // Start ringing timeout
    // Fix 4: Direct = one timer for callId, Group = per-participant timers
    if (callSession.callMode === CALL_MODE.DIRECT) {
      startRingTimer(io, callId, null, CALL_MODE.DIRECT);
    } else {
      for (const recipientId of recipientIds) {
        startRingTimer(io, callId, recipientId, CALL_MODE.GROUP);
      }
    }

    // Notify initiator that call is ringing
    emitToUser(io, userId, SOCKET_EVENTS.CALL_RINGING, { callId });
  } catch (err) {
    const code = err.code || "INTERNAL_ERROR";

    // Fix 3: Emit call:busy to caller UI with busy user metadata
    if (code === "CALL_BUSY") {
      const busyUserId = err.metadata?.busyUserId || null;
      const busyCallId = err.metadata?.busyCallId || null;
      emitToUser(io, userId, SOCKET_EVENTS.CALL_BUSY, {
        targetUserId: busyUserId,
        callId: busyCallId,
        reason: "user_busy",
      });
    }

    sendError(socket, callback, code, err.message);
  }
}

/**
 * Handle call:accept — accept an incoming call.
 */
async function handleCallAccept(io, socket, userId, data, callback) {
  try {
    const { callId } = data || {};
    if (!callId) {
      return sendError(socket, callback, "INVALID_INPUT", "callId is required");
    }

    const result = await callService.acceptCall({ userId, callId });
    const { callSession, tokenPayload } = result;

    // Join this user to the call room
    socket.join(`call:${callId}`);

    // Fix 4: Cancel only THIS participant's ring timer (not others')
    cancelRingTimer(callId, userId);

    // Send token ONLY to the accepting user (via ack)
    sendOk(callback, {
      callId,
      token: tokenPayload.token,
      uid: tokenPayload.uid,
      channelName: tokenPayload.channelName,
      callSession: buildPublicCallPayload(callSession),
    });

    // Notify all other participants that this user accepted (NO token)
    emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_ACCEPTED, {
      callId,
      userId,
      participant: buildParticipantPayload(
        callSession.participants.find((p) => String(p.userId) === String(userId)) || { userId },
      ),
      callSession: buildPublicCallPayload(callSession),
    }, userId);
  } catch (err) {
    const code = err.code || "INTERNAL_ERROR";
    sendError(socket, callback, code, err.message);
  }
}

/**
 * Handle call:reject — reject an incoming call.
 */
async function handleCallReject(io, socket, userId, data, callback) {
  try {
    const { callId } = data || {};
    if (!callId) {
      return sendError(socket, callback, "INVALID_INPUT", "callId is required");
    }

    const result = await callService.rejectCall({ userId, callId });
    const { ended, callSession } = result;

    // Fix 4: Cancel ring timer — direct: the one timer, group: only this participant's
    if (ended) {
      // Call ended (direct or all rejected) — cancel all timers
      cancelAllRingTimers(callId);
    } else {
      // Group: only this participant rejected, cancel only their timer
      cancelRingTimer(callId, userId);
    }

    sendOk(callback, { callId, ended });

    if (ended) {
      // Notify all participants the call ended
      emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_ENDED, {
        callId,
        endedBy: userId,
        reason: ENDED_REASON.CALLEE_REJECTED,
        callSession: buildPublicCallPayload(callSession),
      });
    } else {
      // Group: just notify this user rejected
      emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_REJECTED, {
        callId,
        userId,
        callSession: buildPublicCallPayload(callSession),
      });
    }
  } catch (err) {
    const code = err.code || "INTERNAL_ERROR";
    sendError(socket, callback, code, err.message);
  }
}

/**
 * Handle call:cancel — cancel a ringing call (initiator only).
 */
async function handleCallCancel(io, socket, userId, data, callback) {
  try {
    const { callId } = data || {};
    if (!callId) {
      return sendError(socket, callback, "INVALID_INPUT", "callId is required");
    }

    const result = await callService.cancelCall({ userId, callId });
    const { callSession } = result;

    // Cancel ALL ring timers for this call
    cancelAllRingTimers(callId);

    sendOk(callback, { callId });

    // Notify all participants
    emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_CANCELLED, {
      callId,
      cancelledBy: userId,
      callSession: buildPublicCallPayload(callSession),
    });
  } catch (err) {
    const code = err.code || "INTERNAL_ERROR";
    sendError(socket, callback, code, err.message);
  }
}

/**
 * Handle call:end — end an active call.
 */
async function handleCallEnd(io, socket, userId, data, callback) {
  try {
    const { callId } = data || {};
    if (!callId) {
      return sendError(socket, callback, "INVALID_INPUT", "callId is required");
    }

    const result = await callService.endCall({ userId, callId });
    const { ended, selfOnly, callSession } = result;

    // Cancel any lingering timers
    cancelAllRingTimers(callId);

    sendOk(callback, { callId, ended, selfOnly });

    if (ended) {
      // Call fully ended — notify all participants
      emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_ENDED, {
        callId,
        endedBy: userId,
        reason: callSession.endedReason || ENDED_REASON.USER_ENDED,
        callSession: buildPublicCallPayload(callSession),
      });

      // Cleanup reconnect timers for this call
      cancelAllReconnectTimers(callId);
    } else if (selfOnly) {
      // Group: only this user left, call continues
      emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_PARTICIPANT_LEFT, {
        callId,
        userId,
        reason: "left",
        callSession: buildPublicCallPayload(callSession),
      });

      // Broadcast updated state
      emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_STATE_UPDATED, {
        callId,
        callSession: buildPublicCallPayload(callSession),
      });
    }
  } catch (err) {
    const code = err.code || "INTERNAL_ERROR";
    sendError(socket, callback, code, err.message);
  }
}

/**
 * Handle call:join — join an existing group call (late join).
 * Fix 1: Delegates entirely to callService.joinCall() — no Agora in socket layer.
 */
async function handleCallJoin(io, socket, userId, data, callback) {
  try {
    const { callId } = data || {};
    if (!callId) {
      return sendError(socket, callback, "INVALID_INPUT", "callId is required");
    }

    const result = await callService.joinCall({ userId, callId });
    const { callSession: updatedCall, tokenPayload } = result;

    // Cancel reconnect timer if any (user was reconnecting)
    cancelReconnectTimer(callId, userId);

    // Join call room
    socket.join(`call:${callId}`);

    // Send token ONLY to the joining user (via ack)
    sendOk(callback, {
      callId,
      token: tokenPayload.token,
      uid: tokenPayload.uid,
      channelName: tokenPayload.channelName,
      callSession: buildPublicCallPayload(updatedCall),
    });

    // Notify other participants (NO token)
    emitToAllParticipants(io, updatedCall, SOCKET_EVENTS.CALL_PARTICIPANT_JOINED, {
      callId,
      userId,
      participant: buildParticipantPayload(
        updatedCall.participants.find((p) => String(p.userId) === userId) || { userId },
      ),
      callSession: buildPublicCallPayload(updatedCall),
    }, userId);
  } catch (err) {
    const code = err.code || "INTERNAL_ERROR";
    sendError(socket, callback, code, err.message);
  }
}

/**
 * Handle call:leave — leave an active group call.
 */
async function handleCallLeave(io, socket, userId, data, callback) {
  try {
    const { callId } = data || {};
    if (!callId) {
      return sendError(socket, callback, "INVALID_INPUT", "callId is required");
    }

    // Reuse endCall logic (it handles group leave correctly)
    const result = await callService.endCall({ userId, callId });
    const { ended, selfOnly, callSession } = result;

    // Leave call room
    socket.leave(`call:${callId}`);

    sendOk(callback, { callId, ended, selfOnly });

    if (ended) {
      cancelAllRingTimers(callId);

      emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_ENDED, {
        callId,
        endedBy: userId,
        reason: callSession.endedReason || ENDED_REASON.USER_ENDED,
        callSession: buildPublicCallPayload(callSession),
      });

      // Cleanup reconnect timers
      cancelAllReconnectTimers(callId);
    } else if (selfOnly) {
      emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_PARTICIPANT_LEFT, {
        callId,
        userId,
        reason: "left",
        callSession: buildPublicCallPayload(callSession),
      });

      emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_STATE_UPDATED, {
        callId,
        callSession: buildPublicCallPayload(callSession),
      });
    }
  } catch (err) {
    const code = err.code || "INTERNAL_ERROR";
    sendError(socket, callback, code, err.message);
  }
}

/**
 * Handle call:heartbeat — client heartbeat to confirm still connected.
 * Resets the reconnect grace timer for this user if one exists.
 */
function handleCallHeartbeat(io, socket, userId, data) {
  const { callId } = data || {};
  if (!callId) return;

  // If there's a reconnect timer for this user, cancel it (they're alive)
  cancelReconnectTimer(callId, userId);
}

// ─── Disconnect Handling ──────────────────────────────────────────────────

/**
 * Called when a socket disconnects. Checks if the user was in an active call
 * and starts the reconnect grace timer if so.
 *
 * Fix 2: Multi-device hardening — this function is called AFTER unregisterSocket
 * in socketHandler.js, so onlineUsers is already updated. If the user still has
 * other sockets, remainingSockets.size > 0 and we skip reconnect handling.
 *
 * @param {Object} io - Socket.IO server instance
 * @param {string} userId - The disconnected user's ID
 * @param {string} socketId - The disconnected socket's ID
 */
async function handleDisconnect(io, userId, socketId) {
  if (!userId) return;

  try {
    // Fix 2: Check if this user has any OTHER connected sockets (multi-device)
    // This check happens AFTER unregisterSocket, so it's accurate
    const userKey = String(userId);
    const remainingSockets = onlineUsers.get(userKey);
    if (remainingSockets && remainingSockets.size > 0) {
      // User still has other sockets connected — no disconnect handling needed
      return;
    }

    // User is fully offline — check if they're in an active call
    const activeCall = await callService.getActiveCall(userId);
    if (!activeCall || !activeCall.callSession) return;

    const { callSession } = activeCall;
    const callId = callSession.callId;

    // Only handle ACTIVE calls (not ringing — ringing disconnect is handled by ring timeout)
    if (callSession.status === CALL_STATUS.ACTIVE) {
      // Mark participant as disconnected in DB
      await callService.handleParticipantDisconnect(callId, userId);

      // Notify other participants
      emitToAllParticipants(io, callSession, SOCKET_EVENTS.CALL_PARTICIPANT_DISCONNECTED, {
        callId,
        userId,
        graceMs: TIMEOUTS.RECONNECT_GRACE_MS,
        callSession: buildPublicCallPayload(callSession),
      }, userId);

      // Start reconnect grace timer
      startReconnectTimer(io, callId, userId);

      console.log(
        `[call-socket] User ${userId} disconnected from active call ${callId}, ` +
        `reconnect grace started (${TIMEOUTS.RECONNECT_GRACE_MS}ms)`,
      );
    } else if (callSession.status === CALL_STATUS.RINGING) {
      // If the disconnected user was the callee and is still invited → they're offline
      // For direct calls, this means the callee went offline during ringing
      // We let the ring timeout handle this naturally (30s)
      console.log(
        `[call-socket] User ${userId} disconnected during ringing call ${callId}, ` +
        `ring timeout will handle`,
      );
    }
  } catch (err) {
    console.error(`[call-socket] Disconnect handler error for user ${userId}:`, err.message);
  }
}

// ─── Registration ─────────────────────────────────────────────────────────

/**
 * Register all call-related socket event handlers for a single socket connection.
 * Called from socketHandler.js inside handleSocketConnection().
 *
 * @param {Object} io - Socket.IO server instance
 * @param {Object} socket - Socket instance (already authenticated, user attached)
 */
function registerCallHandlers(io, socket) {
  const userId = socket.user?.id || socket.user?.userId;
  if (!userId) return;

  const uid = String(userId);

  // ── Client → Server events ────────────────────────────────────────────

  socket.on(SOCKET_EVENTS.CALL_START, (data, callback) => {
    handleCallStart(io, socket, uid, data, callback);
  });

  socket.on(SOCKET_EVENTS.CALL_ACCEPT, (data, callback) => {
    handleCallAccept(io, socket, uid, data, callback);
  });

  socket.on(SOCKET_EVENTS.CALL_REJECT, (data, callback) => {
    handleCallReject(io, socket, uid, data, callback);
  });

  socket.on(SOCKET_EVENTS.CALL_CANCEL, (data, callback) => {
    handleCallCancel(io, socket, uid, data, callback);
  });

  socket.on(SOCKET_EVENTS.CALL_END, (data, callback) => {
    handleCallEnd(io, socket, uid, data, callback);
  });

  socket.on(SOCKET_EVENTS.CALL_JOIN, (data, callback) => {
    handleCallJoin(io, socket, uid, data, callback);
  });

  socket.on(SOCKET_EVENTS.CALL_LEAVE, (data, callback) => {
    handleCallLeave(io, socket, uid, data, callback);
  });

  socket.on(SOCKET_EVENTS.CALL_HEARTBEAT, (data) => {
    handleCallHeartbeat(io, socket, uid, data);
  });

  // ── Reconnect: check if user was in a call and rejoin ─────────────────

  // Fix 5: On reconnect, emit call:state-updated with full snapshot
  // This handles: background/foreground recovery, multi-device sync,
  // and the GET /api/calls/active → socket state-updated flow.
  (async () => {
    try {
      const activeCall = await callService.getActiveCall(uid);
      if (!activeCall || !activeCall.callSession) return;

      const { callSession } = activeCall;
      const callId = callSession.callId;
      const participant = callModel.findParticipant(callSession, uid);

      if (participant && participant.connectionState === "disconnected") {
        // User was disconnected — reconnect them
        cancelReconnectTimer(callId, uid);

        // Mark as reconnected in DB
        const result = await callService.handleParticipantReconnect(callId, uid);
        const { callSession: updated, tokenPayload } = result;

        // Join call room
        socket.join(`call:${callId}`);

        // Send fresh token to reconnecting user (token only to them)
        emitToUser(io, uid, SOCKET_EVENTS.CALL_PARTICIPANT_RECONNECTED, {
          callId,
          userId: uid,
          token: tokenPayload.token,
          uid: tokenPayload.uid,
          channelName: tokenPayload.channelName,
          callSession: buildPublicCallPayload(updated),
        });

        // Notify other participants (NO token)
        emitToAllParticipants(io, updated, SOCKET_EVENTS.CALL_PARTICIPANT_RECONNECTED, {
          callId,
          userId: uid,
          callSession: buildPublicCallPayload(updated),
        }, uid);

        console.log(`[call-socket] User ${uid} reconnected to call ${callId}`);
      } else if (participant && participant.status === PARTICIPANT_STATUS.ACCEPTED) {
        // User is already accepted — rejoin the room
        socket.join(`call:${callId}`);

        // Fix 5: Emit call:state-updated with current snapshot for state sync
        emitToUser(io, uid, SOCKET_EVENTS.CALL_STATE_UPDATED, {
          callId,
          callSession: buildPublicCallPayload(callSession),
        });

        console.log(`[call-socket] User ${uid} re-joined call room ${callId}`);
      }
    } catch (err) {
      // Non-critical — don't crash on reconnect check
      console.error(`[call-socket] Reconnect check error for user ${uid}:`, err.message);
    }
  })();
}

// ─── Module Exports ───────────────────────────────────────────────────────

module.exports = {
  registerCallHandlers,
  handleDisconnect,
  // Expose timer functions for callRecovery.js boot-time recovery
  startRingTimer,
  startReconnectTimer,
  // Expose for testing/cleanup
  _activeRingTimers: activeRingTimers,
  _reconnectGraceTimers: reconnectGraceTimers,
};
