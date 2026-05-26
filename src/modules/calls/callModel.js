/**
 * DynamoDB schema definition and factory for the ott_call_sessions table.
 *
 * This module defines the structure of a call session document and provides
 * a factory function to create new call session items with sensible defaults.
 *
 * Table: ott_call_sessions (env: DDB_CALL_SESSIONS_TABLE)
 * Primary Key: callId (String)
 * GSI: conversationId-index on conversationId (for querying active calls per conversation)
 */

const { v4: uuidv4 } = require("uuid");
const {
  CALL_STATUS,
  CALL_MODE,
  CALL_TYPE,
  PARTICIPANT_STATUS,
  CONNECTION_STATE,
} = require("./call.constants");

const CALLS_TABLE = process.env.DDB_CALL_SESSIONS_TABLE || "ott_call_sessions";

/**
 * Create a new call session document ready to be stored in DynamoDB.
 *
 * @param {Object} params
 * @param {string} params.conversationId - The conversation/group ID this call belongs to
 * @param {string} params.initiatorId - The userId of the person who started the call
 * @param {string} params.callMode - "direct" or "group" (from CALL_MODE)
 * @param {string} params.callType - "audio" or "video" (from CALL_TYPE)
 * @param {string} params.channelName - The Agora channel name
 * @param {Array<Object>} [params.initialParticipants] - Pre-populated participants (e.g. for group call invites)
 * @returns {Object} A complete call session item for DynamoDB
 */
function createCallSession({
  conversationId,
  initiatorId,
  callMode,
  callType,
  channelName,
  initialParticipants = [],
}) {
  const now = new Date().toISOString();
  const callId = `call_${Date.now()}_${uuidv4().split("-")[0]}`;

  // Build participants array: initiator is always the caller/first participant
  const initiatorParticipant = {
    userId: String(initiatorId),
    role: "caller",
    status: PARTICIPANT_STATUS.ACCEPTED,
    connectionState: CONNECTION_STATE.CONNECTED,
    joinedAt: now,
    leftAt: null,
    disconnectedAt: null,
    reconnectedAt: null,
  };

  // Additional participants (group call invites or direct call callee)
  const extraParticipants = initialParticipants.map((p) => ({
    userId: String(p.userId),
    role: p.role || "callee",
    status: p.status || PARTICIPANT_STATUS.INVITED,
    connectionState: CONNECTION_STATE.CONNECTED,
    joinedAt: null,
    leftAt: null,
    disconnectedAt: null,
    reconnectedAt: null,
  }));

  return {
    callId,
    conversationId: String(conversationId),
    initiatorId: String(initiatorId),
    callMode,
    callType,
    provider: "agora",
    channelName: channelName || callId,
    participants: [initiatorParticipant, ...extraParticipants],
    status: CALL_STATUS.RINGING,
    endedReason: null,
    endedBy: null,
    startedAt: null,
    endedAt: null,
    durationSeconds: 0,
    callLogCreated: false, // Idempotency flag for call_log message creation
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Find a participant in a call session by userId.
 *
 * @param {Object} callSession - The call session document
 * @param {string} userId - The user ID to find
 * @returns {Object|null} The participant object or null
 */
function findParticipant(callSession, userId) {
  if (!callSession || !Array.isArray(callSession.participants)) return null;
  return (
    callSession.participants.find((p) => p.userId === String(userId)) || null
  );
}

/**
 * Check if a call session is in an active or ringing state.
 *
 * @param {Object} callSession - The call session document
 * @returns {boolean}
 */
function isActiveCall(callSession) {
  return (
    callSession &&
    (callSession.status === CALL_STATUS.ACTIVE ||
      callSession.status === CALL_STATUS.RINGING)
  );
}

/**
 * Calculate the duration in seconds between two ISO timestamps.
 *
 * @param {string} start - ISO 8601 start time
 * @param {string} end - ISO 8601 end time
 * @returns {number} Duration in seconds (0 if invalid)
 */
function calculateDuration(start, end) {
  if (!start || !end) return 0;
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (isNaN(startTime) || isNaN(endTime) || endTime <= startTime) return 0;
  return Math.floor((endTime - startTime) / 1000);
}

module.exports = {
  CALLS_TABLE,
  createCallSession,
  findParticipant,
  isActiveCall,
  calculateDuration,
};
