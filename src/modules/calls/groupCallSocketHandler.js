'use strict';

const groupCallService = require('./groupCallService');
const { onlineUsers: defaultOnlineUsers } = require('../../socket/socketUserRegistry');

/**
 * GROUP CALL SOCKET HANDLER — CLEAN REBUILD
 *
 * Registers group-specific socket events only.
 * Does NOT touch direct call logic.
 */

function getSocketUserId(socket) {
  return socket.userId || socket.user?.userId || socket.user?.id;
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
      socket.emit('group-call:started', {
        sessionId: session.id,
        callType: 'GROUP',
        channelName: session.channelName,
        token: hostJoinPayload.token,
        uid: hostJoinPayload.uid,
        conversationId,
        participants: result.participants,
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
            participants: result.participants,
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

      for (const p of joinedParticipants) {
        if (String(p.userId) === String(userId)) continue; // skip self
        const targetSockets = getUserSockets(io, p.userId, onlineUsers);
        for (const s of targetSockets) {
          s.emit('group-call:participant-joined', {
            sessionId,
            joinedUserId: userId,
            participants: joinedParticipants.map((jp) => ({
              userId: jp.userId,
              status: jp.status,
            })),
          });
        }
      }

      // Also notify still-RINGING participants so they know someone joined
      const allParticipants = await groupCallRepo.getParticipantsBySession(sessionId);
      const ringingParticipants = allParticipants.filter(
        (p) => p.status === 'RINGING' || p.status === 'INVITED'
      );
      for (const p of ringingParticipants) {
        const targetSockets = getUserSockets(io, p.userId, onlineUsers);
        for (const s of targetSockets) {
          s.emit('group-call:state', {
            sessionId,
            status: 'ACTIVE',
            participants: allParticipants.map((ap) => ({
              userId: ap.userId,
              status: ap.status,
            })),
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
    } catch (err) {
      console.error('[GROUP_CALL_END_ERROR]', err.message);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function broadcastSessionEnded(io, sessionId, onlineUsers, reason = 'ended') {
  const groupCallRepo = require('./groupCallRepository');
  const allParticipants = await groupCallRepo.getParticipantsBySession(sessionId);
  
  for (const p of allParticipants) {
    const targetSockets = getUserSockets(io, p.userId, onlineUsers);
    for (const s of targetSockets) {
      s.emit('group-call:ended', {
        sessionId,
        reason,
      });
    }
  }
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
