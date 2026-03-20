const { ddbDocClient } = require('../config/awsConfig');
const { PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

// Bảng messages trong DynamoDB (primary key: conversationId (S))
// Mỗi conversationId sẽ là 1 document chứa mảng messages
const MESSAGES_TABLE = process.env.DDB_MESSAGES_TABLE || 'ott_messages';

// conversationId vẫn giữ dạng "channel:1" hoặc "direct:1" để tương thích với API hiện tại

async function saveMessage(payload) {
  if (!payload.conversationId) {
    throw new Error('conversationId is required');
  }
  if (!payload.senderId) {
    throw new Error('senderId is required');
  }

  const createdAt = new Date().toISOString();
  const id = Date.now();

  const newMessage = {
    id,
    senderId: payload.senderId,
    contentType: payload.contentType || 'text',
    content: payload.content || '',
    attachments: payload.attachments || null,
    reactions: payload.reactions || null,
    createdAt
  };

  // Lấy conversation hiện tại (nếu có)
  const getRes = await ddbDocClient.send(new GetCommand({
    TableName: MESSAGES_TABLE,
    Key: { conversationId: payload.conversationId }
  }));

  const existing = getRes.Item || { conversationId: payload.conversationId, messages: [] };
  const messages = Array.isArray(existing.messages) ? existing.messages.slice() : [];
  messages.push(newMessage);

  await ddbDocClient.send(new PutCommand({
    TableName: MESSAGES_TABLE,
    Item: {
      conversationId: payload.conversationId,
      messages
    }
  }));

  return {
    id: newMessage.id,
    conversationId: payload.conversationId,
    senderId: newMessage.senderId,
    contentType: newMessage.contentType,
    content: newMessage.content,
    attachments: newMessage.attachments,
    reactions: newMessage.reactions,
    createdAt: newMessage.createdAt
  };
}

async function getMessagesForConversation(conversationId) {
  if (!conversationId) return [];

  const res = await ddbDocClient.send(new GetCommand({
    TableName: MESSAGES_TABLE,
    Key: { conversationId }
  }));

  if (!res.Item || !Array.isArray(res.Item.messages)) {
    return [];
  }

  // Đảm bảo sắp xếp theo thời gian
  const messages = res.Item.messages.slice().sort((a, b) => {
    const aTime = a.createdAt || '';
    const bTime = b.createdAt || '';
    return aTime.localeCompare(bTime);
  });

  return messages.map((msg) => ({
    id: msg.id,
    conversationId,
    senderId: msg.senderId,
    contentType: msg.contentType,
    content: msg.content,
    attachments: msg.attachments || null,
    reactions: msg.reactions || null,
    createdAt: msg.createdAt
  }));
}

module.exports = {
  saveMessage,
  getMessagesForConversation
};
