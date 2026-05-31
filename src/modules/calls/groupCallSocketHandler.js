'use strict';

const groupCallService = require('./groupCallService');
const { onlineUsers: defaultOnlineUsers } = require('../../socket/socketUserRegistry');
const { ddbDocClient } = require('../../config/awsConfig');
const { GetCommand } = require('@aws-sdk/lib-dynamodb');
const USERS_TABLE = process.env.DDB_USERS_TABLE || 'ott_users';

/**
 * GROUP CALL SOCKET HANDLER — CLEAN REBUILD
 *
 * Registers group-specific socket events only.
 * Does NOT touch direct call logic.
 */

function getSocketUserId(socket) {
  return socket.userId || socket.user?.userId || socket.user?.id;
}

/**
 * Look up user display info from ott_users table.
 */
async function getUserDisplayInfo(userId) {
  try {
    const result = await ddbDocClient.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { userId: String(userId) },
      }),
    );
    const u = result.Item;
    return {
      displayName: u?.display_name || u?.username || String(userId),
      avatarUrl: u?.avatar_url || null,
    };
  } catch {
    return { displayName: String(userId), avatarUrl: null };
  }
}

/**
 * Generate deterministic Agora UID from userId (same algorithm as groupCallService.hashCode).
 */
function hashCode(str) {
  let hash = 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Enrich a list of participants with displayName, avatarUrl, and agoraUid.
 * @param {Array<{userId: string, role?: string, status?: string}>} participants
 * @returns {Promise<Array<{userId, displayName, avatarUrl, agoraUid, role, status}>>}
 */
async function enrichParticipants(participants) {
  return Promise.all(
    (participants || []).map(async (p) => {
      const info = await getUserDisplayInfo(p.userId);
      return {
        userId: p.userId,
        displayName: info.displayName,
        avatarUrl: info.avatarUrl,
        agoraUid: hashCode(p.userId),
        ...(p.role !== undefined && { role: p.role }),
        ...(p.status !== undefined && { status: p.status }),
      };
    }),
  );
}

function registerGroupCallSocketHandlers(io, socket, onlineUsers = defaultOnlineUsers) {
  // ── group-call:start ──────────────────────────────────────────────────────
  socket.on('group-call:start', async (data) => {
    try {
      const { conversationId } = data;
      const userId = getSocketUserId(socket);
      if (!userId || !conversationId) return;

      console.log(`[GROUP_CALL_START] userId=${userId} conversationId=${conversationId}`);

      // Resolve group members from the socket room or data
      const memberUserIds = data.memberUserIds || [];
      if (!memberUserIds.includes(userId)) {
        memberUserIds.unshift(userId);
      }

      const result = await groupCallService.startGroupCall({
        conversationId,
        hostUserId: userId,
        memberUserIds,
      });

      const { session, hostJoinPayload, inviteeUserIds } = result;

      // Send join payload to host (the caller)
      const enrichedParticipants = await enrichParticipants(result.participants);

      socket.emit('group-call:started', {
        sessionId: session.id,
        callType: 'GROUP',
        channelName: session.channelName,
        token: hostJoinPayload.token,
        uid: hostJoinPayload.uid,
        conversationId,
        participants: enrichedParticipants,
      });

      // Emit incoming to each invitee
      for (const inviteeId of inviteeUserIds) {
        const sockets = getUserSockets(io, inviteeId, onlineUsers);
        const socketCount = sockets.length;
        console.log(`[GROUP_CALL_INCOMING_EMIT] userId=${inviteeId} socketCount=${socketCount}`);

        for (const s of sockets) {
          s.emit('group-call:incoming', {
            sessionId: session.id,
            callType: 'GROUP',
            conversationId,
            channelName: session.channelName,
            hostUserId: userId,
            participants: enrichedParticipants,
          });
        }
      }
    } catch (err) {
      console.error('[GROUP_CALL_START_ERROR]', err.message);
      socket.emit('group-call:error', { message: err.message });
    }
  });

  // ── group-call:accept ─────────────────────────────────────────────────────
  socket.on('group-call:accept', async (data) => {
    try {
      const sessionId = data.sessionId || data.callId;
      const userId = getSocketUserId(socket);
      if (!userId || !sessionId) return;

      console.log(`[GROUP_CALL_ACCEPT] sessionId=${sessionId} userId=${userId}`);

      const joinPayload = await groupCallService.acceptGroupCall({ sessionId, userId });

      // Send join info ONLY to the accepting user
      socket.emit('group-call:accepted', joinPayload);

      console.log(`[GROUP_CALL_ACCEPTED_EMIT] sessionId=${sessionId} userId=${userId}`);

      // Broadcast participant-joined to all already-JOINED participants
      // We need to get joined participants to notify them
      const groupCallRepo = require('./groupCallRepository');
      const joinedParticipants = await groupCallRepo.getJoinedParticipants(sessionId);
      const enrichedJoined = await enrichParticipants(joinedParticipants);

      for (const p of joinedParticipants) {
        if (String(p.userId) === String(userId)) continue; // skip self
        const targetSockets = getUserSockets(io, p.userId, onlineUsers);
        for (const s of targetSockets) {
          s.emit('group-call:participant-joined', {
            sessionId,
            joinedUserId: userId,
            participants: enrichedJoined,
          });
        }
      }

      // Also notify still-RINGING participants so they know someone joined
      const allParticipants = await groupCallRepo.getParticipantsBySession(sessionId);
      const enrichedAll = await enrichParticipants(allParticipants);
      const ringingParticipants = allParticipants.filter(
        (p) => p.status === 'RINGING' || p.status === 'INVITED'
      );
      for (const p of ringingParticipants) {
        const targetSockets = getUserSockets(io, p.userId, onlineUsers);
        for (const s of targetSockets) {
          s.emit('group-call:state', {
            sessionId,
            status: 'ACTIVE',
            participants: enrichedAll,
          });
        }
      }
    } catch (err) {
      console.error('[GROUP_CALL_ACCEPT_ERROR]', err.message);
      socket.emit('group-call:error', { message: err.message });
    }
  });

  // ── group-call:reject ─────────────────────────────────────────────────────
  socket.on('group-call:reject', async (data) => {
    try {
      const sessionId = data.sessionId || data.callId;
      const userId = getSocketUserId(socket);
      if (!userId || !sessionId) return;

      await groupCallService.rejectGroupCall({ sessionId, userId });

      // Broadcast to already-joined participants
      const groupCallRepo = require('./groupCallRepository');
      const joinedParticipants = await groupCallRepo.getJoinedParticipants(sessionId);
      for (const p of joinedParticipants) {
        const targetSockets = getUserSockets(io, p.userId, onlineUsers);
        for (const s of targetSockets) {
          s.emit('group-call:participant-rejected', {
            sessionId,
            rejectedUserId: userId,
          });
        }
      }

      // Check if session ended
      const session = await groupCallRepo.getSession(sessionId);
      if (session && session.status === 'ENDED') {
        await broadcastSessionEnded(io, sessionId, onlineUsers);
        emitConversationCallEnded(io, session, 'all_rejected');
      }
    } catch (err) {
      console.error('[GROUP_CALL_REJECT_ERROR]', err.message);
    }
  });

  // ── group-call:leave ──────────────────────────────────────────────────────
  socket.on('group-call:leave', async (data) => {
    try {
      const sessionId = data.sessionId || data.callId;
      const userId = getSocketUserId(socket);
      if (!userId || !sessionId) return;

      console.log(`[GROUP_CALL_LEAVE] sessionId=${sessionId} userId=${userId}`);

      await groupCallService.leaveGroupCall({ sessionId, userId });

      // Broadcast to remaining joined participants
      const groupCallRepo = require('./groupCallRepository');
      const joinedParticipants = await groupCallRepo.getJoinedParticipants(sessionId);
      for (const p of joinedParticipants) {
        const targetSockets = getUserSockets(io, p.userId, onlineUsers);
        for (const s of targetSockets) {
          s.emit('group-call:participant-left', {
            sessionId,
            leftUserId: userId,
          });
        }
      }

      // Check if session ended
      const session = await groupCallRepo.getSession(sessionId);
      if (session && session.status === 'ENDED') {
        await broadcastSessionEnded(io, sessionId, onlineUsers);
        emitConversationCallEnded(io, session, 'all_left');
      }
    } catch (err) {
      console.error('[GROUP_CALL_LEAVE_ERROR]', err.message);
    }
  });

  // ── group-call:end ────────────────────────────────────────────────────────
  socket.on('group-call:end', async (data) => {
    try {
      const sessionId = data.sessionId || data.callId;
      const userId = getSocketUserId(socket);
      if (!userId || !sessionId) return;

      console.log(`[GROUP_CALL_END] sessionId=${sessionId} userId=${userId}`);

      const result = await groupCallService.endGroupCall({
        sessionId,
        userId,
        reason: 'host_ended',
      });

      // Broadcast ended to ALL participants
      await broadcastSessionEnded(io, sessionId, onlineUsers, result.reason);
      const session = await require('./groupCallRepository').getSession(sessionId);
      emitConversationCallEnded(io, session, result.reason);
    } catch (err) {
      console.error('[GROUP_CALL_END_ERROR]', err.message);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function broadcastSessionEnded(io, sessionId, onlineUsers, reason = 'ended') {
  const groupCallRepo = require('./groupCallRepository');
  const session = await groupCallRepo.getSession(sessionId);
  const allParticipants = await groupCallRepo.getParticipantsBySession(sessionId);
  
  for (const p of allParticipants) {
    const targetSockets = getUserSockets(io, p.userId, onlineUsers);
    for (const s of targetSockets) {
      s.emit('group-call:ended', {
        sessionId,
        callId: sessionId,
        conversationId: session?.conversationId || null,
        reason,
      });
    }
  }
}

function emitConversationCallEnded(io, session, reason = 'ended') {
  if (!session?.conversationId) return;

  io.to(String(session.conversationId)).emit('group_call_ended', {
    type: 'GROUP_CALL',
    status: 'ended',
    phase: 'ended',
    conversationId: String(session.conversationId),
    callId: String(session.id || session.callId),
    reason,
    content: 'Cuộc gọi đã kết thúc',
  });
}

function getUserSockets(io, userId, onlineUsers) {
  const sockets = [];
  const socketIds = onlineUsers.get(String(userId));
  if (socketIds) {
    for (const sid of socketIds) {
      const s = io.sockets.sockets.get(sid);
      if (s) sockets.push(s);
    }
  }
  return sockets;
}

module.exports = {
  registerGroupCallHandlers: registerGroupCallSocketHandlers,
  registerGroupCallSocketHandlers,
};
