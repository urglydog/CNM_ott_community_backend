'use strict';

const groupCallRepo = require('./groupCallRepository');
const AgoraProvider = require('./providers/agoraProvider');

const agoraProvider = new AgoraProvider();

/**
 * GROUP CALL SERVICE — CLEAN REBUILD
 *
 * Each function is participant-scoped. No global session mutation on accept.
 */

// ── Start Group Call ──────────────────────────────────────────────────────────

async function startGroupCall({ conversationId, hostUserId, memberUserIds }) {
  console.log(`[GROUP_CALL_START] conversationId=${conversationId} host=${hostUserId}`);

  // Check for existing active session
  const existing = await groupCallRepo.getActiveSessionByConversation(conversationId);
  if (existing) {
    console.log(`[GROUP_CALL_START] existing session ${existing.id} found, ending it first`);
    await groupCallRepo.endSession(existing.id, 'replaced');
  }

  // Generate channel name from session
  const channelName = `group_${conversationId}_${Date.now()}`;

  // Create session
  const session = await groupCallRepo.createSession({
    conversationId,
    channelName,
    hostUserId,
  });

  console.log(`[GROUP_CALL_START] sessionId=${session.id} channelName=${channelName}`);

  // Create participants: host = JOINED, others = RINGING
  const hostParticipant = await groupCallRepo.createParticipant({
    sessionId: session.id,
    userId: hostUserId,
    role: 'HOST',
    status: 'JOINED',
  });

  const invitees = memberUserIds.filter((id) => id !== hostUserId);
  console.log(`[GROUP_CALL_MEMBERS] members=[${memberUserIds.join(',')}] invitees=[${invitees.join(',')}]`);

  for (const memberId of invitees) {
    await groupCallRepo.createParticipant({
      sessionId: session.id,
      userId: memberId,
      role: 'MEMBER',
      status: 'RINGING',
    });
  }

  console.log(`[GROUP_CALL_PARTICIPANTS_INIT] host=JOINED invitees=RINGING count=${invitees.length}`);

  // Generate Agora token for host
  const hostUid = hashCode(hostUserId);
  const hostToken = agoraProvider.generateToken(channelName, hostUid);

  console.log(`[GROUP_CALL_JOIN_TOKEN] sessionId=${session.id} userId=${hostUserId} channelName=${channelName} uid=${hostUid}`);

  // Return full session + host join info
  const allParticipants = await groupCallRepo.getParticipantsBySession(session.id);

  // Create system message in chat
  await createGroupCallActiveMessage(session, allParticipants);

  return {
    session: {
      id: session.id,
      callType: 'GROUP',
      conversationId,
      channelName,
      hostUserId,
      status: 'RINGING',
    },
    hostJoinPayload: {
      sessionId: session.id,
      callType: 'GROUP',
      channelName,
      token: hostToken,
      uid: hostUid,
      conversationId,
    },
    participants: allParticipants.map((p) => ({
      userId: p.userId,
      role: p.role,
      status: p.status,
    })),
    inviteeUserIds: invitees,
  };
}

// ── Accept Group Call ─────────────────────────────────────────────────────────

async function acceptGroupCall({ sessionId, userId }) {
  console.log(`[GROUP_CALL_ACCEPT] sessionId=${sessionId} userId=${userId}`);

  const session = await groupCallRepo.getSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  if (session.status === 'ENDED' || session.status === 'FAILED') {
    throw new Error('Session already ended');
  }

  const participant = await groupCallRepo.getParticipant(sessionId, userId);
  if (!participant) {
    throw new Error('Not a participant');
  }
  if (participant.status === 'JOINED') {
    // Idempotent: already joined, return existing join token
    console.log(`[GROUP_ACCEPT_IDEMPOTENT] sessionId=${sessionId} userId=${userId} — already JOINED, returning existing payload`);
    const uid = hashCode(userId);
    const token = agoraProvider.generateToken(session.channelName, uid);
    return {
      sessionId,
      callType: 'GROUP',
      channelName: session.channelName,
      token,
      uid,
      conversationId: session.conversationId,
    };
  }
  if (participant.status !== 'RINGING' && participant.status !== 'INVITED') {
    throw new Error(`Cannot accept: current status is ${participant.status}`);
  }

  // Update ONLY this participant
  await groupCallRepo.updateParticipantStatus(sessionId, userId, 'JOINED');

  console.log(`[GROUP_CALL_PARTICIPANT_JOINED] sessionId=${sessionId} userId=${userId}`);

  // Generate Agora token
  const uid = hashCode(userId);
  const token = agoraProvider.generateToken(session.channelName, uid);

  console.log(`[GROUP_CALL_JOIN_TOKEN] sessionId=${sessionId} userId=${userId} channelName=${session.channelName} uid=${uid}`);

  // Update session to ACTIVE if still RINGING
  if (session.status === 'RINGING') {
    await groupCallRepo.updateSessionStatus(sessionId, 'ACTIVE');
  }

  return {
    sessionId,
    callType: 'GROUP',
    channelName: session.channelName,
    token,
    uid,
    conversationId: session.conversationId,
  };
}

// ── Reject Group Call ─────────────────────────────────────────────────────────

async function rejectGroupCall({ sessionId, userId }) {
  console.log(`[GROUP_CALL_REJECT] sessionId=${sessionId} userId=${userId}`);

  const participant = await groupCallRepo.getParticipant(sessionId, userId);
  if (!participant) {
    throw new Error('Not a participant');
  }
  if (participant.status === 'JOINED') {
    console.log(`[GROUP_REJECT_IGNORED] reason=already_joined sessionId=${sessionId} userId=${userId}`);
    return;
  }

  await groupCallRepo.updateParticipantStatus(sessionId, userId, 'REJECTED');

  // Check if session should end (no joined and no ringing left)
  await checkAndMaybeEndSession(sessionId, 'all_rejected');
}

// ── Leave Group Call ──────────────────────────────────────────────────────────

async function leaveGroupCall({ sessionId, userId }) {
  console.log(`[GROUP_CALL_LEAVE] sessionId=${sessionId} userId=${userId}`);

  const participant = await groupCallRepo.getParticipant(sessionId, userId);
  if (!participant) {
    throw new Error('Not a participant');
  }

  await groupCallRepo.updateParticipantStatus(sessionId, userId, 'LEFT');

  // Check if session should end
  await checkAndMaybeEndSession(sessionId, 'all_left');
}

// ── End Group Call (host or admin) ────────────────────────────────────────────

async function endGroupCall({ sessionId, userId, reason = 'host_ended' }) {
  console.log(`[GROUP_CALL_END] sessionId=${sessionId} reason=${reason}`);

  const session = await groupCallRepo.getSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  // Mark remaining participants as LEFT
  const participants = await groupCallRepo.getParticipantsBySession(sessionId);
  for (const p of participants) {
    if (p.status === 'JOINED' || p.status === 'RINGING' || p.status === 'INVITED') {
      await groupCallRepo.updateParticipantStatus(sessionId, p.userId, 'LEFT');
    }
  }

  await groupCallRepo.endSession(sessionId, reason);
  await createGroupCallLogMessage(sessionId, reason);

  return { sessionId, reason };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function checkAndMaybeEndSession(sessionId, reason) {
  // Single read to avoid race conditions between multiple DynamoDB queries
  const allParticipants = await groupCallRepo.getParticipantsBySession(sessionId);

  // Normalize status to lowercase for comparison
  const norm = (s) => String(s || '').toLowerCase();

  const joinedCount = allParticipants.filter((p) => norm(p.status) === 'joined').length;
  const ringingCount = allParticipants.filter(
    (p) => norm(p.status) === 'ringing' || norm(p.status) === 'invited'
  ).length;

  // Diagnostic log
  console.log(`[GROUP_ALL_LEFT_CHECK] sessionId=${sessionId} joinedCount=${joinedCount} ringingCount=${ringingCount} participants=[${allParticipants.map((p) => `${p.userId}:${norm(p.status)}`).join(',')}]`);

  if (joinedCount === 0 && ringingCount === 0) {
    console.log(`[GROUP_CALL_END] auto-ending sessionId=${sessionId} reason=${reason}`);
    await groupCallRepo.endSession(sessionId, reason);
    await createGroupCallLogMessage(sessionId, reason);
    return true;
  }
  return false;
}

/**
 * Deterministic hash code for user ID → Agora uid (uint32)
 */
function hashCode(str) {
  let hash = 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit int
  }
  return Math.abs(hash);
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Create a "group_call_active" system message when a group call starts.
 * IDEMPOTENT: uses activeCallMessageCreated flag to prevent duplicate messages.
 *
 * @param {Object} session - The group call session
 * @param {string} session.id - The session/call ID
 * @param {string} session.conversationId - The conversation ID
 * @param {string} session.hostUserId - The initiator's user ID
 * @param {string} session.channelName - The Agora channel name
 * @param {string} session.startedAt - When the call started
 * @param {Array} participants - Array of { userId, role, status }
 */
async function createGroupCallActiveMessage(session, participants) {
  if (!session || !session.conversationId) return;

  // Idempotency guard
  const marked = await groupCallRepo.markActiveCallMessageCreated(session.id);
  if (!marked) return; // Already created

  const participantIds = (participants || []).map((p) => String(p.userId));

  const callData = {
    callId: session.id,
    callMode: "group",
    callType: "video",
    callStatus: "active",
    conversationId: session.conversationId,
    startedAt: session.startedAt || new Date().toISOString(),
    initiatorId: session.hostUserId,
    participantIds,
  };

  try {
    const { saveMessage } = require("../messages/messageService");
    const savedMessage = await saveMessage({
      conversationId: session.conversationId,
      senderId: session.hostUserId,
      content: "Cuộc gọi nhóm đang diễn ra",
      contentType: "group_call_active",
      callData,
    });

    // Broadcast realtime
    try {
      const { getIO } = require("../../socket/socketHandler");
      const io = getIO();
      if (io && savedMessage) {
        const roomId = session.conversationId;
        console.log(`[group-call:system-message] Broadcasting group_call_active to room ${roomId}`, savedMessage.id);
        io.to(roomId).emit("receive_message", savedMessage);
      }
    } catch (emitErr) {
      console.error("[group-call:system-message] Failed to broadcast realtime:", emitErr.message);
    }
  } catch (err) {
    console.error("[group-call:system-message] Failed to create message:", err.message);
    // Don't throw — message creation failure should not break the call flow
  }
}

/**
 * Create a "call_log" system message when a group call ends.
 * IDEMPOTENT: uses callLogCreated flag to prevent duplicate messages.
 *
 * @param {string} sessionId - The ended session ID
 * @param {string} endedReason - Why the call ended
 */
async function createGroupCallLogMessage(sessionId, endedReason) {
  if (!sessionId) return;

  // Idempotency guard
  const marked = await groupCallRepo.markCallLogCreated(sessionId);
  if (!marked) return; // Already created

  try {
    // Re-read session to get final state
    const session = await groupCallRepo.getSession(sessionId);
    if (!session || !session.conversationId) return;

    const participants = await groupCallRepo.getParticipantsBySession(sessionId);
    const norm = (s) => String(s || '').toLowerCase();

    const acceptedCount = participants.filter((p) => norm(p.status) === 'joined').length;
    const rejectedCount = participants.filter((p) => norm(p.status) === 'rejected').length;
    const missedCount = participants.filter(
      (p) => norm(p.status) === 'missed' || norm(p.status) === 'ringing' || norm(p.status) === 'invited'
    ).length;
    const participantCount = participants.length;

    // Calculate duration
    const startedAt = session.startedAt || session.createdAt;
    const endedAt = session.endedAt || new Date().toISOString();
    let durationSeconds = 0;
    if (startedAt) {
      durationSeconds = Math.max(0, Math.floor((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000));
    }

    // Build content string
    let statusSuffix = "";
    switch (endedReason) {
      case "host_ended":
      case "user_ended":
        statusSuffix = durationSeconds > 0 ? ` · ${formatDuration(durationSeconds)}` : " · đã kết thúc";
        break;
      case "all_left":
      case "group_empty":
        statusSuffix = " · tất cả đã rời";
        break;
      case "all_rejected":
        statusSuffix = " · đã từ chối";
        break;
      case "replaced":
        statusSuffix = " · bị thay thế";
        break;
      case "system_cleanup":
        statusSuffix = " · hệ thống";
        break;
      default:
        statusSuffix = durationSeconds > 0 ? ` · ${formatDuration(durationSeconds)}` : "";
        break;
    }

    const content = `Cuộc gọi nhóm${statusSuffix}`;

    const callData = {
      callId: sessionId,
      callMode: "group",
      callType: session.callType || "video",
      callStatus: "ended",
      endedReason: endedReason || null,
      durationSeconds,
      initiatorId: session.initiatorId || session.hostUserId || session.callerId,
      acceptedCount,
      rejectedCount,
      missedCount,
      participantCount,
    };

    const { saveMessage } = require("../messages/messageService");
    const savedMessage = await saveMessage({
      conversationId: session.conversationId,
      senderId: session.initiatorId || session.hostUserId || session.callerId,
      content,
      contentType: "call_log",
      callData,
    });

    // Broadcast realtime
    try {
      const { getIO } = require("../../socket/socketHandler");
      const io = getIO();
      if (io && savedMessage) {
        const roomId = session.conversationId;
        console.log(`[group-call:call-log] Broadcasting call_log to room ${roomId}`, savedMessage.id);
        io.to(roomId).emit("receive_message", savedMessage);
      }
    } catch (emitErr) {
      console.error("[group-call:call-log] Failed to broadcast realtime:", emitErr.message);
    }
  } catch (err) {
    console.error("[group-call:call-log] Failed to create call_log:", err.message);
    // Don't throw — message creation failure should not break the call flow
  }
}

module.exports = {
  startGroupCall,
  acceptGroupCall,
  rejectGroupCall,
  leaveGroupCall,
  endGroupCall,
  hashCode,
  createGroupCallActiveMessage,
  createGroupCallLogMessage,
};
