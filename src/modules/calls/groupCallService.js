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

module.exports = {
  startGroupCall,
  acceptGroupCall,
  rejectGroupCall,
  leaveGroupCall,
  endGroupCall,
  hashCode,
};
