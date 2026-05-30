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

  // 7. Auto-unpin the message if it was pinned in friendship or group
  let updatedPinnedList = null;
  if (conversationId.startsWith("dm:")) {
    const parts = conversationId.split(":");
    if (parts.length >= 3) {
      try {
        const friendService = require("../users/friendService");
        const rec = await friendService.findExistingRecord(parts[1], parts[2]);
        if (rec) {
          let pinned = Array.isArray(rec.pinnedMessages) ? rec.pinnedMessages : [];
          const isPinned = pinned.some(m => String(m.id) === normalizedMessageId);
          if (isPinned) {
            pinned = pinned.filter(m => String(m.id) !== normalizedMessageId);
            const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
            const FRIENDS_TABLE = process.env.DDB_FRIENDSHIPS_TABLE || "ott_friendships";
            await ddbDocClient.send(new UpdateCommand({
              TableName: FRIENDS_TABLE,
              Key: { friendshipId: String(rec.friendshipId) },
              UpdateExpression: 'SET pinnedMessages = :p, updated_at = :u',
              ExpressionAttributeValues: {
                ':p': pinned,
                ':u': new Date().toISOString()
              }
            }));
            updatedPinnedList = pinned;
          }
        }
      } catch (err) {
        console.error("[revokeMessage] Error unpinning from friendship:", err);
      }
    }
  } else {
    // Group chat
    try {
      const GROUPS_TABLE = process.env.DDB_GROUPS_TABLE || "ott_groups";
      const result = await ddbDocClient.send(new GetCommand({
        TableName: GROUPS_TABLE,
        Key: { groupId: String(conversationId) }
      }));
      const g = result.Item;
      if (g) {
        let pinned = Array.isArray(g.pinnedMessages) ? g.pinnedMessages : [];
        const isPinned = pinned.some(m => String(m.id) === normalizedMessageId);
        if (isPinned) {
          pinned = pinned.filter(m => String(m.id) !== normalizedMessageId);
          const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
          await ddbDocClient.send(new UpdateCommand({
            TableName: GROUPS_TABLE,
            Key: { groupId: String(conversationId) },
            UpdateExpression: 'SET pinnedMessages = :p',
            ExpressionAttributeValues: { ':p': pinned }
          }));
          updatedPinnedList = pinned;
        }
      }
    } catch (err) {
      console.error("[revokeMessage] Error unpinning from group:", err);
    }
  }

  return {
    conversationId,
    messageId: normalizedMessageId,
    revokedAt: new Date().toISOString(),
    revokedBy: userId,
    updatedPinnedList,
  };
}

module.exports = { revokeMessage };
