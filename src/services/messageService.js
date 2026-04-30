const { ddbDocClient } = require("../config/awsConfig");
const { PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

// Bảng messages trong DynamoDB (primary key: conversationId (S))
// Mỗi conversationId sẽ là 1 document chứa mảng messages
const MESSAGES_TABLE = process.env.DDB_MESSAGES_TABLE || "ott_messages";

// conversationId vẫn giữ dạng "channel:1" hoặc "direct:1" để tương thích với API hiện tại

function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return null;
  }

  const normalized = attachments
    .filter((attachment) => attachment && typeof attachment === "object")
    .map((attachment) => ({
      url: attachment.url || "",
      key: attachment.key || "",
      name: attachment.name || "",
      mimeType: attachment.mimeType || attachment.contentType || "",
      size: Number.isFinite(attachment.size) ? attachment.size : null,
    }))
    .filter((attachment) => attachment.url && attachment.key);

  return normalized.length > 0 ? normalized : null;
}

function resolveContentType(payload, attachments) {
  if (payload.contentType) {
    return payload.contentType;
  }

  if (attachments && attachments.length > 0) {
    const firstAttachment = attachments[0];
    if (
      firstAttachment.mimeType &&
      firstAttachment.mimeType.startsWith("image/")
    ) {
      return "image";
    }

    return "file";
  }

  return "text";
}

function buildConversationIdFromPayload(payload) {
  if (payload.conversationId) {
    return payload.conversationId;
  }

  if (payload.channelId) {
    return `channel:${payload.channelId}`;
  }

  if (payload.directChatId) {
    return `direct:${payload.directChatId}`;
  }

  return "";
}

async function saveMessage(payload) {
  const conversationId = buildConversationIdFromPayload(payload);
  if (!conversationId) {
    throw new Error("conversationId is required");
  }

  // ── Validate ──────────────────────────────────────────────
  if (!payload.senderId) {
    throw new Error("senderId is required");
  }
  if (!payload.content || !payload.content.trim()) {
    throw new Error('content is required');
  }

  const attachments = normalizeAttachments(payload.attachments);
  const contentType = resolveContentType(payload, attachments);
  const content = typeof payload.content === "string" ? payload.content : "";

  const createdAt = new Date().toISOString();
  const id = Date.now();

  const newMessage = {
    id,
    senderId: payload.senderId,
    contentType,
    content,
    attachments,
    contentType: payload.contentType || 'text',
    content: payload.content.trim(),
    attachments: payload.attachments || null,
    reactions: payload.reactions || null,
    createdAt,
  };

  // Lấy conversation hiện tại (nếu có)
  const getRes = await ddbDocClient.send(
    new GetCommand({
      TableName: MESSAGES_TABLE,
      Key: { conversationId },
    }),
  );

  const existing = getRes.Item || { conversationId, messages: [] };
  const messages = Array.isArray(existing.messages)
    ? existing.messages.slice()
    : [];
  messages.push(newMessage);

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
    id: newMessage.id,
    conversationId,
    senderId: newMessage.senderId,
    contentType: newMessage.contentType,
    content: newMessage.content,
    attachments: newMessage.attachments,
    reactions: newMessage.reactions,
    createdAt: newMessage.createdAt,
  };
}

async function getMessagesForConversation(conversationId) {
  if (!conversationId) return [];

  const res = await ddbDocClient.send(
    new GetCommand({
      TableName: MESSAGES_TABLE,
      Key: { conversationId },
    }),
  );

  if (!res.Item || !Array.isArray(res.Item.messages)) {
    return [];
  }

  // Đảm bảo sắp xếp theo thời gian
  const messages = res.Item.messages.slice().sort((a, b) => {
    const aTime = a.createdAt || "";
    const bTime = b.createdAt || "";
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
    createdAt: msg.createdAt,
  }));
}

module.exports = {
  saveMessage,
  getMessagesForConversation,
};
