const { ddbDocClient } = require("../../config/awsConfig");
const { GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const MESSAGES_TABLE = process.env.DDB_MESSAGES_TABLE || "ott_messages";

/**
 * Revokes (deletes) a message within a conversation.
 *
 * Rules:
 *   - Only the original sender (message.senderId) may revoke their own message.
 *   - The revoked message keeps its `id` and `createdAt` but its content is
 *     wiped and its `contentType` is set to "revoked" so the UI can render the
 *     placeholder "Tin nhắn đã được thu hồi" state.
 *
 * @param {string} conversationId  - DynamoDB primary key (e.g. "channel:1" or "dm:1:2")
 * @param {string} messageId       - The `id` field of the message inside the messages array
 * @param {string} userId         - The id of the requesting user (extracted from JWT)
 * @returns {Promise<object>}      - The revoked message object
 * @throws {Error} with code "MESSAGE_NOT_FOUND"  - when no message with the given id exists
 * @throws {Error} with code "FORBIDDEN"          - when userId !== message.senderId
 */
async function revokeMessage(conversationId, messageId, userId) {
  if (!conversationId) {
    const err = new Error("conversationId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }
  if (!messageId) {
    const err = new Error("messageId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const normalizedMessageId = String(messageId);

  // 1. Fetch the conversation document
  const getRes = await ddbDocClient.send(
    new GetCommand({
      TableName: MESSAGES_TABLE,
      Key: { conversationId },
    }),
  );

  if (!getRes.Item) {
    const err = new Error(`Conversation "${conversationId}" not found`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const messages = Array.isArray(getRes.Item.messages)
    ? getRes.Item.messages.slice()
    : [];

  // 2. Locate the target message
  const msgIndex = messages.findIndex((m) => String(m.id) === normalizedMessageId);

  if (msgIndex === -1) {
    const err = new Error(`Message with id "${messageId}" not found in conversation "${conversationId}"`);
    err.code = "MESSAGE_NOT_FOUND";
    throw err;
  }

  const targetMsg = messages[msgIndex];

  // 3. Permission check – only the sender may revoke their own message
  if (String(targetMsg.senderId) !== String(userId)) {
    const err = new Error("You can only revoke your own messages");
    err.code = "FORBIDDEN";
    throw err;
  }

  // 4. Skip if already revoked
  if (targetMsg.contentType === "revoked") {
    const err = new Error("This message has already been revoked");
    err.code = "ALREADY_REVOKED";
    throw err;
  }

  // 5. Apply the revocation in place
  messages[msgIndex] = {
    ...targetMsg,
    contentType: "revoked",
    content: null,
    attachments: null,
    reactions: null,
  };

  // 6. Persist the updated messages array back to DynamoDB
  await ddbDocClient.send(
    new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: {
        conversationId,
        messages,
      },
    }),
  );

  return {
    conversationId,
    messageId: normalizedMessageId,
    revokedAt: new Date().toISOString(),
    revokedBy: userId,
  };
}

module.exports = { revokeMessage };
