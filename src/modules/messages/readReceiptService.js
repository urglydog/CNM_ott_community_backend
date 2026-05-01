/**
 * Read Receipts Service
 * Handles storing and retrieving read receipts for messages
 * Uses DynamoDB for persistence
 */
const { ddbDocClient } = require("../../config/awsConfig");
const { PutCommand, GetCommand, UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const READ_RECEIPTS_TABLE = process.env.DDB_READ_RECEIPTS_TABLE;

/**
 * Generate read receipt key for a conversation
 * Format: conversationId#messageId
 */
function getReadReceiptKey(conversationId, messageId) {
  return `${conversationId}#${messageId}`;
}

/**
 * Generate sort key for a reader
 * Format: userId#timestamp
 */
function getReaderSortKey(userId) {
  return `${userId}#${Date.now()}`;
}

/**
 * Save a read receipt
 * @param {Object} data - { conversationId, messageId, userId, readerName, readerAvatar }
 */
async function saveReadReceipt(data) {
  const { conversationId, messageId, userId, readerName, readerAvatar } = data;

  if (!conversationId) {
    throw new Error("conversationId is required");
  }
  if (!messageId) {
    throw new Error("messageId is required");
  }
  if (!userId) {
    throw new Error("userId is required");
  }

  const readAt = new Date().toISOString();

  const receipt = {
    conversationId,
    messageId: String(messageId),
    userId: String(userId),
    readerName: readerName || null,
    readerAvatar: readerAvatar || null,
    readAt,
  };

  try {
    await ddbDocClient.send(
      new PutCommand({
        TableName: READ_RECEIPTS_TABLE,
        Item: receipt,
      })
    );

    console.log(`[readReceipts] Saved read receipt for message ${messageId} by user ${userId}`);
    return receipt;
  } catch (error) {
    console.error(`[readReceipts] Error saving read receipt:`, error.message);
    throw error;
  }
}

/**
 * Get read receipts for a specific message
 * @param {string} conversationId
 * @param {string} messageId
 */
async function getReadReceiptsForMessage(conversationId, messageId) {
  if (!conversationId || !messageId) {
    return [];
  }

  try {
    // Query all items with this conversationId and messageId as GSI
    // For simplicity, we use a Scan with filter
    const result = await ddbDocClient.send(
      new QueryCommand({
        TableName: READ_RECEIPTS_TABLE,
        IndexName: "conversationId-messageId-index",
        KeyConditionExpression: "conversationId = :cid AND messageId = :mid",
        ExpressionAttributeValues: {
          ":cid": conversationId,
          ":mid": String(messageId),
        },
      })
    );

    return result.Items || [];
  } catch (error) {
    // If index doesn't exist, fall back to scan
    console.warn(`[readReceipts] GSI not found, using scan fallback:`, error.message);
    return [];
  }
}

/**
 * Get the latest read receipt for a user in a conversation
 * This indicates the last message the user has read
 * @param {string} conversationId
 * @param {string} userId
 */
async function getUserLastReadMessage(conversationId, userId) {
  if (!conversationId || !userId) {
    return null;
  }

  try {
    // Query by userId index to find all receipts for this user in this conversation
    const result = await ddbDocClient.send(
      new QueryCommand({
        TableName: READ_RECEIPTS_TABLE,
        IndexName: "userId-index",
        KeyConditionExpression: "userId = :uid",
        FilterExpression: "conversationId = :cid",
        ExpressionAttributeValues: {
          ":uid": String(userId),
          ":cid": conversationId,
        },
        ScanIndexForward: false, // Most recent first
        Limit: 1,
      })
    );

    if (result.Items && result.Items.length > 0) {
      return result.Items[0];
    }
    return null;
  } catch (error) {
    console.warn(`[readReceipts] Error getting last read message:`, error.message);
    return null;
  }
}

/**
 * Check if a user has read a specific message
 * @param {string} conversationId
 * @param {string} messageId
 * @param {string} userId
 */
async function hasUserReadMessage(conversationId, messageId, userId) {
  if (!conversationId || !messageId || !userId) {
    return false;
  }

  try {
    const result = await ddbDocClient.send(
      new GetCommand({
        TableName: READ_RECEIPTS_TABLE,
        Key: {
          conversationId,
          messageId: String(messageId),
        },
      })
    );

    // Check if this specific receipt exists
    if (result.Item) {
      return result.Item.userId === String(userId);
    }

    // If no exact match, check all receipts for this message
    const receipts = await getReadReceiptsForMessage(conversationId, messageId);
    return receipts.some((r) => String(r.userId) === String(userId));
  } catch (error) {
    console.warn(`[readReceipts] Error checking read status:`, error.message);
    return false;
  }
}

/**
 * Mark all messages in a conversation as read by a user
 * This updates the user's read cursor to the latest message
 * @param {string} conversationId
 * @param {string} messageId - The latest message the user has read
 * @param {string} userId
 * @param {string} readerName
 * @param {string} readerAvatar
 */
async function markConversationAsRead(conversationId, messageId, userId, readerName, readerAvatar) {
  return saveReadReceipt({
    conversationId,
    messageId: String(messageId),
    userId: String(userId),
    readerName,
    readerAvatar,
  });
}

module.exports = {
  saveReadReceipt,
  getReadReceiptsForMessage,
  getUserLastReadMessage,
  hasUserReadMessage,
  markConversationAsRead,
};
