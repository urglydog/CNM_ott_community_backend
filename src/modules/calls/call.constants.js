/**
 * Call module constants — zero dependencies.
 * Single source of truth for all statuses, types, modes, events, and timeouts.
 */

const CALL_STATUS = Object.freeze({
  RINGING: "ringing",
  ACTIVE: "active",
  ENDED: "ended",
  MISSED: "missed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
});

const CALL_MODE = Object.freeze({
  DIRECT: "direct",
  GROUP: "group",
});

const CALL_TYPE = Object.freeze({
  AUDIO: "audio",
  VIDEO: "video",
});

const PARTICIPANT_STATUS = Object.freeze({
  INVITED: "invited",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  MISSED: "missed",
  LEFT: "left",
});

const CONNECTION_STATE = Object.freeze({
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
});

const ENDED_REASON = Object.freeze({
  USER_ENDED: "user_ended",
  CALLER_CANCELLED: "caller_cancelled",
  CALLEE_REJECTED: "callee_rejected",
  NO_ANSWER_TIMEOUT: "no_answer_timeout",
  DISCONNECT_TIMEOUT: "participant_disconnected_timeout",
  GROUP_EMPTY: "group_empty",
  SYSTEM_CLEANUP: "system_cleanup",
});

const TIMEOUTS = Object.freeze({
  RING_TIMEOUT_MS: 30_000,
  RECONNECT_GRACE_MS: 15_000,
  TOKEN_EXPIRE_SECONDS: parseInt(process.env.AGORA_TOKEN_EXPIRE_SECONDS, 10) || 3600,
});

const SOCKET_EVENTS = Object.freeze({
  // Client → Server
  CALL_START: "call:start",
  CALL_ACCEPT: "call:accept",
  CALL_REJECT: "call:reject",
  CALL_CANCEL: "call:cancel",
  CALL_END: "call:end",
  CALL_JOIN: "call:join",
  CALL_LEAVE: "call:leave",

  // Server → Client
  CALL_INCOMING: "call:incoming",
  CALL_RINGING: "call:ringing",
  CALL_ACCEPTED: "call:accepted",
  CALL_REJECTED: "call:rejected",
  CALL_CANCELLED: "call:cancelled",
  CALL_ENDED: "call:ended",
  CALL_MISSED: "call:missed",
  CALL_PARTICIPANT_JOINED: "call:participant-joined",
  CALL_PARTICIPANT_LEFT: "call:participant-left",
  CALL_PARTICIPANT_DISCONNECTED: "call:participant-disconnected",
  CALL_PARTICIPANT_RECONNECTED: "call:participant-reconnected",
  CALL_STATE_UPDATED: "call:state-updated",
  CALL_BUSY: "call:busy",
});

module.exports = {
  CALL_STATUS,
  CALL_MODE,
  CALL_TYPE,
  PARTICIPANT_STATUS,
  CONNECTION_STATE,
  ENDED_REASON,
  TIMEOUTS,
  SOCKET_EVENTS,
};
