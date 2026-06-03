const CALL_MODE = {
  DIRECT: "direct",
  GROUP: "group",
};

const CALL_TYPE = {
  AUDIO: "audio",
  VIDEO: "video",
};

const CALL_STATUS = {
  RINGING: "ringing",
  ACTIVE: "active",
  ENDED: "ended",
  FAILED: "failed",
  RECONNECTING: "reconnecting",
};

const BLOCKING_STATUSES = [
  CALL_STATUS.RINGING,
  CALL_STATUS.ACTIVE,
  CALL_STATUS.RECONNECTING,
];

const PARTICIPANT_STATUS = {
  INVITED: "invited",
  RINGING: "ringing",
  ACCEPTED: "accepted",
  JOINED: "joined",
  LEFT: "left",
  REJECTED: "rejected",
  MISSED: "missed",
  RECONNECTING: "reconnecting",
};

const PARTICIPANT_ROLE = {
  CALLER: "caller",
  CALLEE: "callee",
  HOST: "host",
  MEMBER: "member",
};

const CONNECTION_STATE = {
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  RECONNECTING: "reconnecting",
};

const ENDED_REASON = {
  USER_ENDED: "user_ended",
  CALLER_CANCELLED: "caller_cancelled",
  CALLEE_REJECTED: "callee_rejected",
  MISSED: "missed",
  TIMEOUT: "timeout",
  NO_ANSWER_TIMEOUT: "no_answer_timeout",
  GROUP_EMPTY: "group_empty",
  DISCONNECT_TIMEOUT: "disconnect_timeout",
  SYSTEM_CLEANUP: "system_cleanup",
};

const END_REASON = {
  HOST_ENDED: "host_ended",
  ALL_LEFT: "all_left",
  TIMEOUT: "timeout",
  FAILED: "failed",
};

const DIRECT_EVENTS = {
  START: "call:start",
  ACCEPT: "call:accept",
  REJECT: "call:reject",
  END: "call:end",
  INCOMING: "direct-call:incoming",
  ACCEPTED: "direct-call:accepted",
  REJECTED: "direct-call:rejected",
  ENDED: "direct-call:ended",
  MISSED: "call:missed",
  ACCEPT_ERROR: "call:accept-error",
};

const GROUP_EVENTS = {
  START: "group-call:start",
  ACCEPT: "group-call:accept",
  REJECT: "group-call:reject",
  LEAVE: "group-call:leave",
  END: "group-call:end",
  INCOMING: "group-call:incoming",
  PARTICIPANT_JOINED: "group-call:participant-joined",
  PARTICIPANT_LEFT: "group-call:participant-left",
  PARTICIPANT_REJECTED: "group-call:participant-rejected",
  ENDED: "group-call:ended",
  STATE: "group-call:state",
};

const SOCKET_EVENTS = {
  CALL_START: DIRECT_EVENTS.START,
  CALL_ACCEPT: DIRECT_EVENTS.ACCEPT,
  CALL_REJECT: DIRECT_EVENTS.REJECT,
  CALL_CANCEL: "call:cancel",
  CALL_END: DIRECT_EVENTS.END,
  CALL_JOIN: "call:join",
  CALL_LEAVE: "call:leave",
  CALL_HEARTBEAT: "call:heartbeat",

  CALL_INCOMING: DIRECT_EVENTS.INCOMING,
  CALL_RINGING: "call:ringing",
  CALL_ACCEPTED: DIRECT_EVENTS.ACCEPTED,
  CALL_REJECTED: DIRECT_EVENTS.REJECTED,
  CALL_CANCELLED: "call:cancelled",
  CALL_ENDED: DIRECT_EVENTS.ENDED,
  CALL_MISSED: DIRECT_EVENTS.MISSED,
  CALL_PARTICIPANT_JOINED: "call:participant-joined",
  CALL_PARTICIPANT_LEFT: "call:participant-left",
  CALL_PARTICIPANT_DISCONNECTED: "call:participant-disconnected",
  CALL_PARTICIPANT_RECONNECTED: "call:participant-reconnected",
  CALL_STATE_UPDATED: "call:state-updated",
  CALL_BUSY: "call:busy",
  CALL_ERROR: "call:error",

  DIRECT_CALL_ACCEPT: "direct-call:accept",
  DIRECT_CALL_REJECT: "direct-call:reject",
  DIRECT_CALL_END: "direct-call:end",
  DIRECT_CALL_INCOMING: "direct-call:incoming",
  DIRECT_CALL_ACCEPTED: "direct-call:accepted",
  DIRECT_CALL_REJECTED: "direct-call:rejected",
  DIRECT_CALL_ENDED: "direct-call:ended",

  GROUP_CALL_START: GROUP_EVENTS.START,
  GROUP_CALL_ACCEPT: GROUP_EVENTS.ACCEPT,
  GROUP_CALL_REJECT: GROUP_EVENTS.REJECT,
  GROUP_CALL_JOIN: "group-call:join",
  GROUP_CALL_LEAVE: GROUP_EVENTS.LEAVE,
  GROUP_CALL_END: GROUP_EVENTS.END,
  GROUP_CALL_INCOMING: GROUP_EVENTS.INCOMING,
  GROUP_CALL_ACCEPTED: "group-call:accepted",
  GROUP_CALL_REJECTED: "group-call:rejected",
  GROUP_CALL_ENDED: GROUP_EVENTS.ENDED,
  GROUP_CALL_PARTICIPANT_JOINED: GROUP_EVENTS.PARTICIPANT_JOINED,
  GROUP_CALL_PARTICIPANT_LEFT: GROUP_EVENTS.PARTICIPANT_LEFT,
};

const CALL_TIMEOUT_MS = 60000;
const GROUP_CALL_TIMEOUT_MS = 120000;
const TIMEOUTS = {
  RING_TIMEOUT_MS: CALL_TIMEOUT_MS,
  GROUP_RING_TIMEOUT_MS: GROUP_CALL_TIMEOUT_MS,
  DISCONNECT_GRACE_MS: 30000,
  HEARTBEAT_INTERVAL_MS: 10000,
  TOKEN_EXPIRE_SECONDS: Number(process.env.AGORA_TOKEN_EXPIRE_SECONDS || 3600),
};

const CALL_WINDOW_PATH = "/call/window";

module.exports = {
  CALL_MODE,
  CALL_TYPE,
  CALL_STATUS,
  BLOCKING_STATUSES,
  PARTICIPANT_STATUS,
  PARTICIPANT_ROLE,
  CONNECTION_STATE,
  ENDED_REASON,
  END_REASON,
  DIRECT_EVENTS,
  GROUP_EVENTS,
  SOCKET_EVENTS,
  TIMEOUTS,
  CALL_TIMEOUT_MS,
  GROUP_CALL_TIMEOUT_MS,
  CALL_WINDOW_PATH,
};
