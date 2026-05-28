'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} = require('@aws-sdk/lib-dynamodb');
const { ddbDocClient } = require('../../config/awsConfig');
const { CALLS_TABLE } = require('./callModel');

const SESSION_STATUS = {
  RINGING: 'ringing',
  ACTIVE: 'active',
  ENDED: 'ended',
  FAILED: 'failed',
};

const PARTICIPANT_STATUS = {
  INVITED: 'invited',
  RINGING: 'ringing',
  JOINED: 'joined',
  LEFT: 'left',
  REJECTED: 'rejected',
  MISSED: 'missed',
  RECONNECTING: 'reconnecting',
};

function nowIso() {
  return new Date().toISOString();
}

function toStoredStatus(status) {
  return String(status || '').toLowerCase();
}

function toServiceStatus(status) {
  return String(status || '').toUpperCase();
}

function isLiveSession(session) {
  const status = toStoredStatus(session?.status);
  return status === SESSION_STATUS.RINGING || status === SESSION_STATUS.ACTIVE;
}

function isLiveParticipant(participant) {
  const status = toStoredStatus(participant?.status);
  return (
    status === PARTICIPANT_STATUS.JOINED ||
    status === PARTICIPANT_STATUS.RINGING ||
    status === PARTICIPANT_STATUS.INVITED
  );
}

function toStoredParticipant(participant) {
  return {
    userId: String(participant.userId),
    role: participant.role || 'MEMBER',
    status: toStoredStatus(participant.status || PARTICIPANT_STATUS.INVITED),
    joinedAt: participant.joinedAt || null,
    leftAt: participant.leftAt || null,
  };
}

function toServiceParticipant(participant) {
  return {
    ...participant,
    role: participant.role || 'MEMBER',
    status: toServiceStatus(participant.status),
  };
}

function toServiceSession(session) {
  if (!session) return null;
  return {
    ...session,
    id: session.callId,
    hostUserId: session.callerId || session.initiatorId,
    status: toServiceStatus(session.status),
    participants: Array.isArray(session.participants)
      ? session.participants.map(toServiceParticipant)
      : [],
  };
}

async function scanAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddbDocClient.send(
      new ScanCommand({
        ...params,
        ExclusiveStartKey,
      }),
    );
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function putSession(session) {
  await ddbDocClient.send(
    new PutCommand({
      TableName: CALLS_TABLE,
      Item: session,
    }),
  );
  return session;
}

// DynamoDB tables are provisioned outside the app, matching the rest of the backend.
async function ensureTables() {
  return undefined;
}

async function createSession({ conversationId, channelName, hostUserId }) {
  const now = nowIso();
  const callId = `gc_${uuidv4().replace(/-/g, '').slice(0, 20)}`;
  const item = {
    callId,
    callType: 'GROUP',
    callMode: 'group',
    conversationId: String(conversationId),
    callerId: String(hostUserId),
    initiatorId: String(hostUserId),
    status: SESSION_STATUS.RINGING,
    channelName,
    participants: [],
    startedAt: now,
    endedAt: null,
    endedReason: null,
    endedBy: null,
    createdAt: now,
    updatedAt: now,
  };

  await ddbDocClient.send(
    new PutCommand({
      TableName: CALLS_TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(callId)',
    }),
  );

  return toServiceSession(item);
}

async function getSession(sessionId) {
  const result = await ddbDocClient.send(
    new GetCommand({
      TableName: CALLS_TABLE,
      Key: { callId: String(sessionId) },
    }),
  );
  return toServiceSession(result.Item || null);
}

async function updateSessionStatus(sessionId, status, endReason = null) {
  const session = await getRawSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const storedStatus = toStoredStatus(status);
  const ended = storedStatus === SESSION_STATUS.ENDED || storedStatus === SESSION_STATUS.FAILED;
  const now = nowIso();

  session.status = storedStatus;
  session.updatedAt = now;
  if (ended) {
    session.endedAt = now;
    session.endedReason = endReason;
  }

  await putSession(session);
  return toServiceSession(session);
}

async function endSession(sessionId, endReason = 'host_ended') {
  return updateSessionStatus(sessionId, SESSION_STATUS.ENDED, endReason);
}

async function createParticipant({ sessionId, userId, role = 'MEMBER', status = 'INVITED' }) {
  const session = await getRawSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const participant = toStoredParticipant({
    userId,
    role,
    status,
    joinedAt: toStoredStatus(status) === PARTICIPANT_STATUS.JOINED ? nowIso() : null,
  });

  const participants = Array.isArray(session.participants) ? session.participants : [];
  const idx = participants.findIndex((p) => String(p.userId) === String(userId));
  if (idx >= 0) {
    participants[idx] = {
      ...participants[idx],
      ...participant,
    };
  } else {
    participants.push(participant);
  }

  session.participants = participants;
  session.updatedAt = nowIso();
  await putSession(session);

  return toServiceParticipant(participant);
}

async function getParticipant(sessionId, userId) {
  const session = await getRawSession(sessionId);
  const participant = (session?.participants || []).find(
    (p) => String(p.userId) === String(userId),
  );
  return participant ? toServiceParticipant(participant) : null;
}

async function getParticipantsBySession(sessionId) {
  const session = await getRawSession(sessionId);
  return (session?.participants || []).map(toServiceParticipant);
}

async function getJoinedParticipants(sessionId) {
  const participants = await getParticipantsBySession(sessionId);
  return participants.filter((p) => toStoredStatus(p.status) === PARTICIPANT_STATUS.JOINED);
}

async function updateParticipantStatus(sessionId, userId, status) {
  const session = await getRawSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const participants = Array.isArray(session.participants) ? session.participants : [];
  const idx = participants.findIndex((p) => String(p.userId) === String(userId));
  if (idx === -1) throw new Error(`Participant ${userId} not found in session ${sessionId}`);

  const storedStatus = toStoredStatus(status);
  const updated = {
    ...participants[idx],
    status: storedStatus,
  };

  if (storedStatus === PARTICIPANT_STATUS.JOINED) {
    updated.joinedAt = nowIso();
  } else if (
    storedStatus === PARTICIPANT_STATUS.LEFT ||
    storedStatus === PARTICIPANT_STATUS.REJECTED ||
    storedStatus === PARTICIPANT_STATUS.MISSED
  ) {
    updated.leftAt = nowIso();
  }

  participants[idx] = updated;
  session.participants = participants;
  session.updatedAt = nowIso();
  await putSession(session);

  return toServiceParticipant(updated);
}

async function getActiveSessionByConversation(conversationId) {
  let items = [];
  try {
    const result = await ddbDocClient.send(
      new QueryCommand({
        TableName: CALLS_TABLE,
        IndexName: 'conversationId-index',
        KeyConditionExpression: 'conversationId = :conversationId',
        ExpressionAttributeValues: {
          ':conversationId': String(conversationId),
        },
      }),
    );
    items = result.Items || [];
  } catch {
    items = await scanAll({
      TableName: CALLS_TABLE,
      FilterExpression: 'conversationId = :conversationId',
      ExpressionAttributeValues: {
        ':conversationId': String(conversationId),
      },
    });
  }

  const active = items
    .filter((item) => item.callType === 'GROUP' || item.callMode === 'group')
    .filter(isLiveSession)
    .sort((a, b) =>
      String(b.startedAt || b.createdAt || '').localeCompare(String(a.startedAt || a.createdAt || '')),
    )[0];

  return toServiceSession(active || null);
}

async function getActiveSessionForUser(userId) {
  const items = await scanAll({
    TableName: CALLS_TABLE,
    FilterExpression: '(callType = :groupType OR callMode = :groupMode)',
    ExpressionAttributeValues: {
      ':groupType': 'GROUP',
      ':groupMode': 'group',
    },
  });

  const uid = String(userId);
  const active = items
    .filter(isLiveSession)
    .filter((item) =>
      (item.participants || []).some(
        (participant) => String(participant.userId) === uid && isLiveParticipant(participant),
      ),
    )
    .sort((a, b) =>
      String(b.startedAt || b.createdAt || '').localeCompare(String(a.startedAt || a.createdAt || '')),
    )[0];

  return toServiceSession(active || null);
}

async function countJoinedParticipants(sessionId) {
  const joined = await getJoinedParticipants(sessionId);
  return joined.length;
}

async function getRawSession(sessionId) {
  const result = await ddbDocClient.send(
    new GetCommand({
      TableName: CALLS_TABLE,
      Key: { callId: String(sessionId) },
    }),
  );
  return result.Item || null;
}

module.exports = {
  ensureTables,
  createSession,
  getSession,
  updateSessionStatus,
  endSession,
  createParticipant,
  getParticipant,
  getParticipantsBySession,
  getJoinedParticipants,
  updateParticipantStatus,
  getActiveSessionByConversation,
  getActiveSessionForUser,
  countJoinedParticipants,
};
