/**
 * Data access layer for ott_call_sessions.
 *
 * All DynamoDB operations for call sessions live here.
 * Business logic (callService) depends on this — never on DynamoDB directly.
 *
 * @see callModel.js for the schema definition
 */

const {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");
const { ddbDocClient } = require("../../config/awsConfig");
const { CALLS_TABLE } = require("./callModel");
const { CALL_STATUS, PARTICIPANT_STATUS, CONNECTION_STATE } = require("./call.constants");

// ─── Create ─────────────────────────────────────────────────────────────────

/**
 * Store a new call session in DynamoDB.
 * Uses a conditional put to prevent duplicate callId.
 *
 * @param {Object} callSession - The call session item from createCallSession()
 * @returns {Object} The stored item
 * @throws {Error} If callId already exists (ConditionalCheckFailedException)
 */
async function create(callSession) {
  await ddbDocClient.send(
    new PutCommand({
      TableName: CALLS_TABLE,
      Item: callSession,
      ConditionExpression: "attribute_not_exists(callId)",
    }),
  );
  return callSession;
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Get a call session by callId.
 *
 * @param {string} callId
 * @returns {Object|null} The call session or null if not found
 */
async function getById(callId) {
  const res = await ddbDocClient.send(
    new GetCommand({
      TableName: CALLS_TABLE,
      Key: { callId },
    }),
  );
  return res.Item || null;
}

/**
 * Find an active or ringing call in a given conversation.
 * Uses the conversationId-index GSI.
 *
 * @param {string} conversationId
 * @returns {Object|null} The active/ringing call session or null
 */
async function findActiveByConversation(conversationId) {
  const res = await ddbDocClient.send(
    new QueryCommand({
      TableName: CALLS_TABLE,
      IndexName: "conversationId-index",
      KeyConditionExpression: "conversationId = :cid",
      FilterExpression: "#s = :ringing OR #s = :active",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":cid": String(conversationId),
        ":ringing": CALL_STATUS.RINGING,
        ":active": CALL_STATUS.ACTIVE,
      },
    }),
  );
  const items = res.Items || [];
  return items.length > 0 ? items[0] : null;
}

/**
 * Check if a user is currently busy in any active or ringing call.
 * Scans the table with a filter on status and participant presence.
 *
 * @param {string} userId
 * @returns {Promise<{busy: boolean, callId?: string}>}
 */
async function isUserBusy(userId) {
  const res = await ddbDocClient.send(
    new ScanCommand({
      TableName: CALLS_TABLE,
      FilterExpression:
        "(#s = :active OR #s = :ringing) AND contains(participants, :uid)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":active": CALL_STATUS.ACTIVE,
        ":ringing": CALL_STATUS.RINGING,
        ":uid": String(userId),
      },
    }),
  );
  const items = res.Items || [];
  if (items.length > 0) {
    return { busy: true, callId: items[0].callId };
  }
  return { busy: false };
}

/**
 * Get call history for a conversation (all statuses), sorted by createdAt descending.
 * Uses the conversationId-index GSI.
 *
 * @param {string} conversationId
 * @param {Object} [options]
 * @param {number} [options.limit=20] - Max items to return
 * @param {Object} [options.exclusiveStartKey] - DynamoDB pagination key
 * @returns {Promise<{items: Array, lastEvaluatedKey?: Object}>}
 */
async function getHistoryByConversation(
  conversationId,
  { limit = 20, exclusiveStartKey } = {},
) {
  const params = {
    TableName: CALLS_TABLE,
    IndexName: "conversationId-index",
    KeyConditionExpression: "conversationId = :cid",
    ExpressionAttributeValues: { ":cid": String(conversationId) },
    ScanIndexForward: false, // newest first
    Limit: limit,
  };
  if (exclusiveStartKey) {
    params.ExclusiveStartKey = exclusiveStartKey;
  }

  const res = await ddbDocClient.send(new QueryCommand(params));
  return {
    items: res.Items || [],
    lastEvaluatedKey: res.LastEvaluatedKey || null,
  };
}

// ─── Update ─────────────────────────────────────────────────────────────────

/**
 * Update the top-level status of a call session.
 *
 * @param {string} callId
 * @param {string} newStatus - One of CALL_STATUS values
 * @param {Object} [extraFields] - Additional fields to set (e.g. endedReason, endedBy, endedAt)
 * @returns {Object} The updated item
 */
async function updateStatus(callId, newStatus, extraFields = {}) {
  const now = new Date().toISOString();

  // Build dynamic SET expressions
  const setParts = ["#s = :status", "updatedAt = :now"];
  const exprNames = { "#s": "status" };
  const exprValues = { ":status": newStatus, ":now": now };

  for (const [key, value] of Object.entries(extraFields)) {
    const safeKey = key.replace(/[^a-zA-Z0-9_]/g, "");
    setParts.push(`#${safeKey} = :${safeKey}`);
    exprNames[`#${safeKey}`] = key;
    exprValues[`:${safeKey}`] = value;
  }

  const res = await ddbDocClient.send(
    new UpdateCommand({
      TableName: CALLS_TABLE,
      Key: { callId },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes;
}

/**
 * Transition a call from RINGING to ACTIVE.
 * Sets startedAt and updates status atomically.
 *
 * @param {string} callId
 * @returns {Object} The updated call session
 */
async function activateCall(callId) {
  const now = new Date().toISOString();
  const res = await ddbDocClient.send(
    new UpdateCommand({
      TableName: CALLS_TABLE,
      Key: { callId },
      UpdateExpression: "SET #s = :active, startedAt = :now, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":active": CALL_STATUS.ACTIVE,
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes;
}

/**
 * End a call: set status=ended, endedAt, endedReason, endedBy, durationSeconds.
 *
 * @param {string} callId
 * @param {string} endedBy - userId who ended the call
 * @param {string} endedReason - One of ENDED_REASON values
 * @param {string} [startedAt] - The call's startedAt (for duration calculation)
 * @returns {Object} The updated call session
 */
async function endCall(callId, endedBy, endedReason, startedAt) {
  const now = new Date().toISOString();
  const durationSeconds = startedAt
    ? Math.floor((new Date(now).getTime() - new Date(startedAt).getTime()) / 1000)
    : 0;

  const res = await ddbDocClient.send(
    new UpdateCommand({
      TableName: CALLS_TABLE,
      Key: { callId },
      UpdateExpression:
        "SET #s = :ended, endedAt = :now, endedBy = :by, endedReason = :reason, durationSeconds = :dur, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":ended": CALL_STATUS.ENDED,
        ":now": now,
        ":by": String(endedBy),
        ":reason": endedReason,
        ":dur": Math.max(0, durationSeconds),
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes;
}

// ─── Participant Updates ────────────────────────────────────────────────────

/**
 * Update a specific participant's fields within the participants list.
 * Uses list_append + filter to update in-place.
 *
 * Since DynamoDB doesn't support updating nested list items by index directly,
 * we read the full item, mutate in memory, and write back (read-modify-write).
 *
 * @param {string} callId
 * @param {string} userId - The participant's userId
 * @param {Object} updates - Fields to set on the participant (e.g. { status, connectionState, joinedAt })
 * @returns {Object} The updated call session
 * @throws {Error} If participant not found
 */
async function updateParticipant(callId, userId, updates) {
  // Read-modify-write for nested list update
  const call = await getById(callId);
  if (!call) throw new Error(`Call ${callId} not found`);

  const idx = call.participants.findIndex(
    (p) => p.userId === String(userId),
  );
  if (idx === -1) {
    throw new Error(
      `Participant ${userId} not found in call ${callId}`,
    );
  }

  // Merge updates into the participant
  call.participants[idx] = {
    ...call.participants[idx],
    ...updates,
  };
  call.updatedAt = new Date().toISOString();

  // Write back the full item
  await ddbDocClient.send(
    new PutCommand({
      TableName: CALLS_TABLE,
      Item: call,
    }),
  );
  return call;
}

/**
 * Add a new participant to an existing call session.
 *
 * @param {string} callId
 * @param {Object} participant - Participant object (userId, role, status, etc.)
 * @returns {Object} The updated call session
 * @throws {Error} If call not found
 */
async function addParticipant(callId, participant) {
  const call = await getById(callId);
  if (!call) throw new Error(`Call ${callId} not found`);

  // Check if participant already exists
  const exists = call.participants.some(
    (p) => p.userId === String(participant.userId),
  );
  if (exists) {
    throw new Error(
      `Participant ${participant.userId} already exists in call ${callId}`,
    );
  }

  call.participants.push({
    userId: String(participant.userId),
    role: participant.role || "callee",
    status: participant.status || PARTICIPANT_STATUS.INVITED,
    connectionState: CONNECTION_STATE.CONNECTED,
    joinedAt: null,
    leftAt: null,
    disconnectedAt: null,
    reconnectedAt: null,
  });
  call.updatedAt = new Date().toISOString();

  await ddbDocClient.send(
    new PutCommand({
      TableName: CALLS_TABLE,
      Item: call,
    }),
  );
  return call;
}

/**
 * Mark a participant as disconnected (socket lost).
 *
 * @param {string} callId
 * @param {string} userId
 * @returns {Object} The updated call session
 */
async function markParticipantDisconnected(callId, userId) {
  return updateParticipant(callId, userId, {
    connectionState: CONNECTION_STATE.DISCONNECTED,
    disconnectedAt: new Date().toISOString(),
  });
}

/**
 * Mark a participant as reconnected.
 *
 * @param {string} callId
 * @param {string} userId
 * @returns {Object} The updated call session
 */
async function markParticipantReconnected(callId, userId) {
  return updateParticipant(callId, userId, {
    connectionState: CONNECTION_STATE.CONNECTED,
    reconnectedAt: new Date().toISOString(),
  });
}

/**
 * Mark a participant as having left the call.
 *
 * @param {string} callId
 * @param {string} userId
 * @returns {Object} The updated call session
 */
async function markParticipantLeft(callId, userId) {
  return updateParticipant(callId, userId, {
    status: PARTICIPANT_STATUS.LEFT,
    leftAt: new Date().toISOString(),
  });
}

// ─── Idempotency ────────────────────────────────────────────────────────────

/**
 * Atomically set callLogCreated = true, but only if it is currently false.
 * Uses a conditional update to prevent concurrent double-writes.
 *
 * @param {string} callId
 * @returns {Promise<boolean>} true if the flag was set (caller should create the log),
 *                              false if it was already true (caller should skip)
 */
async function markCallLogCreated(callId) {
  try {
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: CALLS_TABLE,
        Key: { callId },
        UpdateExpression: "SET callLogCreated = :true",
        ConditionExpression: "callLogCreated = :false",
        ExpressionAttributeValues: {
          ":true": true,
          ":false": false,
        },
      }),
    );
    return true; // We won the race — caller should create the log
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return false; // Already marked — caller should skip
    }
    throw err;
  }
}

// ─── Active Call Lookup ─────────────────────────────────────────────────────

/**
 * Find the active or ringing call that a user is currently participating in.
 * Scans the table with a filter on status and participant presence.
 *
 * @param {string} userId
 * @returns {Promise<Object|null>} The call session or null
 */
async function findActiveForUser(userId) {
  const res = await ddbDocClient.send(
    new ScanCommand({
      TableName: CALLS_TABLE,
      FilterExpression:
        "(#s = :active OR #s = :ringing) AND contains(participants, :uid)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":active": CALL_STATUS.ACTIVE,
        ":ringing": CALL_STATUS.RINGING,
        ":uid": String(userId),
      },
    }),
  );
  const items = res.Items || [];
  return items.length > 0 ? items[0] : null;
}

// ─── Recovery Queries ────────────────────────────────────────────────────────

/**
 * Find all calls with status = RINGING (for boot-time recovery).
 * @returns {Promise<Object[]>} Array of ringing call sessions
 */
async function findAllRinging() {
  const res = await ddbDocClient.send(
    new ScanCommand({
      TableName: CALLS_TABLE,
      FilterExpression: "#s = :ringing",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":ringing": CALL_STATUS.RINGING },
    }),
  );
  return res.Items || [];
}

/**
 * Find all calls with status = ACTIVE (for boot-time recovery).
 * @returns {Promise<Object[]>} Array of active call sessions
 */
async function findAllActive() {
  const res = await ddbDocClient.send(
    new ScanCommand({
      TableName: CALLS_TABLE,
      FilterExpression: "#s = :active",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":active": CALL_STATUS.ACTIVE },
    }),
  );
  return res.Items || [];
}

module.exports = {
  create,
  getById,
  findActiveByConversation,
  findActiveForUser,
  isUserBusy,
  getHistoryByConversation,
  updateStatus,
  activateCall,
  endCall,
  updateParticipant,
  addParticipant,
  markParticipantDisconnected,
  markParticipantReconnected,
  markParticipantLeft,
  markCallLogCreated,
  findAllRinging,
  findAllActive,
};
