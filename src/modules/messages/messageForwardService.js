const { ddbDocClient } = require("../../config/awsConfig");
const { GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const MESSAGES_TABLE = process.env.DDB_MESSAGES_TABLE || "ott_messages";
const USERS_TABLE = process.env.DDB_USERS_TABLE || "ott_users";

/**
 * Looks up the sender's displayName and avatar_url from ott_users.
 *
 * @param {string} senderId
 * @returns {Promise<{ senderDisplayName: string, senderAvatarUrl: string | null }>}
 */
async function enrichSenderInfo(senderId) {
  const result = await ddbDocClient.send(
    new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId: String(senderId) },
    }),
  );
  const u = result.Item;
  return {
    senderDisplayName: u?.display_name || u?.username || String(senderId),
    senderAvatarUrl: u?.avatar_url || null,
  };
}

/**
 * Validates that every target conversation exists in DynamoDB.
 * Silently skips targets that match the source conversation to avoid
 * a self-forward producing an error.
 *
 * @param {string[]} targetConversationIds
 * @param {string} sourceConversationId
 * @returns {Promise<{ valid: string[], missing: string[] }>}
 */
async function validateTargetConversations(
  targetConversationIds,
  sourceConversationId,
) {
  const uniqueTargets = [...new Set(targetConversationIds)];
  const valid = [];
  const missing = [];

  for (const convId of uniqueTargets) {
    if (convId === sourceConversationId) continue; // self-forward is a no-op

    const getRes = await ddbDocClient.send(
      new GetCommand({
        TableName: MESSAGES_TABLE,
        Key: { conversationId: convId },
      }),
    );

    if (getRes.Item) {
      valid.push(convId);
    } else {
      missing.push(convId);
    }
  }

  return { valid, missing };
}

/**
 * Retrieves a single message from a conversation by its id.
 *
 * @param {string} conversationId  - DynamoDB primary key
 * @param {string|number} messageId
 * @returns {Promise<object|null>}  - The message object or null if not found
 */
async function getMessageById(conversationId, messageId) {
  const getRes = await ddbDocClient.send(
    new GetCommand({
      TableName: MESSAGES_TABLE,
      Key: { conversationId },
    }),
  );

  if (!getRes.Item || !Array.isArray(getRes.Item.messages)) {
    return null;
  }

  return (
    getRes.Item.messages.find((m) => String(m.id) === String(messageId)) || null
  );
}

/**
 * Saves a forwarded copy of a message into a target conversation.
 *
 * @param {string} targetConversationId - Destination conversation PK
 * @param {object} originalMessage      - The source message object
 * @param {string} senderId              - The user performing the forward
 * @returns {Promise<object>}            - The newly created forwarded message
 */
async function saveForwardedMessage(
  targetConversationId,
  originalMessage,
  senderId,
) {
  const createdAt = new Date().toISOString();
  const newId = Date.now();

  const forwardedMessage = {
    id: newId,
    senderId: String(senderId),
    content: originalMessage.content || "",
    contentType: originalMessage.contentType || "text",
    attachments: originalMessage.attachments || null,
    reactions: null,
    createdAt,
    conversationId: targetConversationId,
    isForwarded: true,
    originalSenderId: originalMessage.senderId
      ? String(originalMessage.senderId)
      : null,
    originalMessageId: originalMessage.id ? String(originalMessage.id) : null,
    originalConversationId: originalMessage.conversationId || null,
  };

  // Fetch existing conversation document
  const getRes = await ddbDocClient.send(
    new GetCommand({
      TableName: MESSAGES_TABLE,
      Key: { conversationId: targetConversationId },
    }),
  );

  const existing = getRes.Item || {
    conversationId: targetConversationId,
    messages: [],
  };
  const messages = Array.isArray(existing.messages)
    ? existing.messages.slice()
    : [];
  messages.push(forwardedMessage);

  await ddbDocClient.send(
    new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: {
        conversationId: targetConversationId,
        messages,
      },
    }),
  );

  return forwardedMessage;
}

/**
 * Main entry point. Forwards a message from a source conversation to one or
 * more target conversations.
 *
 * @param {object} params
 * @param {string|number} params.originalMessageId   - id of the message to forward
 * @param {string}        params.sourceConversationId - PK of the source conversation
 * @param {string[]}      params.targetConversationIds - Array of destination PKs
 * @param {string}        params.senderId              - JWT userId doing the forward
 * @returns {Promise<{ results: object[], skipped: string[] }>}
 *
 * @throws {Error} with code "BAD_REQUEST"          - missing or invalid parameters
 * @throws {Error} with code "SOURCE_NOT_FOUND"     - source conversation not in DB
 * @throws {Error} with code "MESSAGE_NOT_FOUND"   - original message not found
 */
async function forwardMessage({
  originalMessageId,
  sourceConversationId,
  targetConversationIds,
  senderId,
}) {
  // ── Input validation ──────────────────────────────────────────────────────
  if (!originalMessageId) {
    const err = new Error("originalMessageId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }
  if (!sourceConversationId) {
    const err = new Error("sourceConversationId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }
  if (
    !Array.isArray(targetConversationIds) ||
    targetConversationIds.length === 0
  ) {
    const err = new Error("targetConversationIds must be a non-empty array");
    err.code = "BAD_REQUEST";
    throw err;
  }
  if (!senderId) {
    const err = new Error("senderId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }

  // ── Retrieve original message ─────────────────────────────────────────────
  // Group file/image messages có thể được lưu ở "channel:<groupId>".
  // UI lại có thể gửi sourceConversationId dạng "<groupId>", nên cần fallback tìm ở cả 2 key.
  const sourceCandidates = [String(sourceConversationId)];
  if (
    !String(sourceConversationId).startsWith("dm:") &&
    !String(sourceConversationId).startsWith("channel:")
  ) {
    sourceCandidates.push(`channel:${sourceConversationId}`);
  }

  let sourceDoc = null;
  let resolvedSourceConversationId = String(sourceConversationId);

  for (const candidateId of sourceCandidates) {
    let getSourceRes;
    try {
      getSourceRes = await ddbDocClient.send(
        new GetCommand({
          TableName: MESSAGES_TABLE,
          Key: { conversationId: candidateId },
        }),
      );
    } catch (dbError) {
      console.error(
        "[messageForwardService] DynamoDB GetCommand failed:",
        dbError,
      );
      const err = new Error(
        "Failed to fetch source conversation from database",
      );
      err.code = "INTERNAL_ERROR";
      throw err;
    }

    if (getSourceRes.Item) {
      sourceDoc = getSourceRes.Item;
      resolvedSourceConversationId = candidateId;
      break;
    }
  }

  if (!sourceDoc) {
    const err = new Error(
      `Source conversation "${sourceConversationId}" not found`,
    );
    err.code = "SOURCE_NOT_FOUND";
    throw err;
  }

  const sourceMessages = Array.isArray(sourceDoc.messages)
    ? sourceDoc.messages
    : [];
  const originalMessage = sourceMessages.find(
    (m) =>
      String(m.id) === String(originalMessageId) ||
      String(m.message_id) === String(originalMessageId) ||
      String(m.messageId) === String(originalMessageId),
  );

  if (!originalMessage) {
    const err = new Error(
      `Message with id "${originalMessageId}" not found in source conversation "${resolvedSourceConversationId}"`,
    );
    err.code = "MESSAGE_NOT_FOUND";
    throw err;
  }

  // ── Validate & deduplicate targets ────────────────────────────────────────
  const { valid: validTargets, missing: missingTargets } =
    await validateTargetConversations(
      targetConversationIds,
      resolvedSourceConversationId,
    );

  // ── Create forwarded copies ───────────────────────────────────────────────
  const results = [];
  const errors = [];

  for (const targetId of validTargets) {
    try {
      const savedMsg = await saveForwardedMessage(
        targetId,
        originalMessage,
        senderId,
      );

      // Enrich with sender display info for real-time delivery
      const enriched = await enrichSenderInfo(senderId);

      results.push({
        targetConversationId: targetId,
        forwardedMessage: {
          ...savedMsg,
          senderDisplayName: enriched.senderDisplayName,
          senderAvatarUrl: enriched.senderAvatarUrl,
        },
      });
    } catch (forwardError) {
      console.error(
        `[messageForwardService] Failed to forward to "${targetId}":`,
        forwardError,
      );
      errors.push({
        targetConversationId: targetId,
        error: forwardError.message,
      });
    }
  }

  return { results, skipped: missingTargets, errors };
}

module.exports = {
  forwardMessage,
  getMessageById,
  enrichSenderInfo,
  validateTargetConversations,
  saveForwardedMessage,
};
