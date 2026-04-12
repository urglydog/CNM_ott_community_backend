const { ddbDocClient } = require("../../config/awsConfig");
const { PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const { s3Client } = require("../../config/awsConfig");

// Bảng messages trong DynamoDB (primary key: conversationId (S))
// Mỗi conversationId sẽ là 1 document chứa mảng messages
const MESSAGES_TABLE = process.env.DDB_MESSAGES_TABLE || "ott_messages";
const FILE_MESSAGES_TABLE = process.env.DYNAMODB_TABLE_NAME || MESSAGES_TABLE;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

// conversationId vẫn giữ dạng "channel:1" hoặc "direct:1" để tương thích với API hiện tại

async function saveMessage(payload) {
  // ── Validate ──────────────────────────────────────────────
  if (!payload.conversationId) {
    throw new Error("conversationId is required");
  }
  if (!payload.senderId) {
    throw new Error("senderId is required");
  }
  if (!payload.content || !payload.content.trim()) {
    throw new Error("content is required");
  }

  const createdAt = new Date().toISOString();
  const id = Date.now();

  const newMessage = {
    id,
    senderId: payload.senderId,
    contentType: payload.contentType || "text",
    content: payload.content.trim(),
    attachments: payload.attachments || null,
    reactions: payload.reactions || null,
    createdAt,
  };

  // Lấy conversation hiện tại (nếu có)
  const getRes = await ddbDocClient.send(
    new GetCommand({
      TableName: MESSAGES_TABLE,
      Key: { conversationId: payload.conversationId },
    }),
  );

  const existing = getRes.Item || {
    conversationId: payload.conversationId,
    messages: [],
  };
  const messages = Array.isArray(existing.messages)
    ? existing.messages.slice()
    : [];
  messages.push(newMessage);

  await ddbDocClient.send(
    new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: {
        conversationId: payload.conversationId,
        messages,
      },
    }),
  );

  return {
    id: newMessage.id,
    conversationId: payload.conversationId,
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

function resolveAttachmentType(mimetype) {
  if (!mimetype) return "file";
  if (mimetype.startsWith("image/")) return "image";
  return "file";
}

function sanitizeFilename(filename) {
  return String(filename || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function uploadFileToS3(file) {
  if (!file) {
    throw new Error("file is required");
  }
  if (!S3_BUCKET_NAME) {
    throw new Error("S3_BUCKET_NAME is not configured");
  }

  const fileKey = `messages/${Date.now()}-${uuidv4()}-${sanitizeFilename(file.originalname)}`;

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: fileKey,
    Body: file.buffer,
    ContentType: file.mimetype,
  });

  await s3Client.send(command);

  return {
    url: `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${fileKey}`,
    mimetype: file.mimetype,
    size: file.size,
    originalname: file.originalname,
  };
}

async function saveFileMessage(data) {
  const senderId = data.sender_id || data.senderId;
  const receiverId = data.receiver_id || data.receiverId || null;
  const channelId = data.channel_id || data.channelId || null;

  if (!senderId) {
    throw new Error("sender_id is required");
  }
  if (!receiverId && !channelId) {
    throw new Error("receiver_id or channel_id is required");
  }
  if (!data.attachment || !data.attachment.url) {
    throw new Error("attachment metadata is required");
  }

  const conversationId = channelId
    ? `channel:${channelId}`
    : `dm:${[String(senderId), String(receiverId)].sort((a, b) => Number(a) - Number(b)).join(":")}`;

  const fileMessage = {
    id: Date.now(),
    senderId,
    contentType: "file",
    content: data.attachment.originalname || "[file]",
    attachments: [
      {
        url: data.attachment.url,
        type: resolveAttachmentType(data.attachment.mimetype),
        size: data.attachment.size,
      },
    ],
    reactions: null,
    createdAt: new Date().toISOString(),
  };

  // Ưu tiên lưu đồng nhất với saveMessage để không lệch schema dữ liệu.
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
  messages.push(fileMessage);

  await ddbDocClient.send(
    new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: {
        conversationId,
        messages,
      },
    }),
  );

  const item = {
    message_id: uuidv4(),
    conversation_id: conversationId,
    sender_id: senderId,
    receiver_id: receiverId,
    channel_id: channelId,
    attachments: [
      {
        url: data.attachment.url,
        type: resolveAttachmentType(data.attachment.mimetype),
        size: data.attachment.size,
      },
    ],
    type: "file",
    created_at: new Date().toISOString(),
  };

  return item;
}

module.exports = {
  saveMessage,
  getMessagesForConversation,
  uploadFileToS3,
  saveFileMessage,
};
