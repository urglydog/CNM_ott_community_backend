const { ddbDocClient } = require("../../config/awsConfig");
const { PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { randomUUID } = require("crypto");
const { s3Client } = require("../../config/awsConfig");

// Bảng messages trong DynamoDB (primary key: conversationId (S))
// Mỗi conversationId sẽ là 1 document chứa mảng messages
const MESSAGES_TABLE = process.env.DDB_MESSAGES_TABLE || "ott_messages";
const FILE_MESSAGES_TABLE = process.env.DYNAMODB_TABLE_NAME || MESSAGES_TABLE;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const USERS_TABLE = process.env.DDB_USERS_TABLE || "ott_users";

// conversationId vẫn giữ dạng "channel:1" hoặc "direct:1" để tương thích với API hiện tại

// Các giá trị contentType hợp lệ (backward compatible)
const VALID_CONTENT_TYPES = new Set([
  "text",
  "image",
  "file",
  "video",
  "emoji",
  "sticker",
]);

/**
 * Sanitize và chuẩn hóa contentType.
 * - Giá trị không hợp lệ → mặc định "text"
 * - Cho phép: text | image | file | video | emoji | sticker
 */
function normalizeContentType(raw) {
  const ct = String(raw || "text")
    .toLowerCase()
    .trim();
  return VALID_CONTENT_TYPES.has(ct) ? ct : "text";
}

/**
 * Validate dữ liệu sticker trước khi lưu.
 * stickerUrl hoặc stickerId phải có ít nhất 1 cái.
 * @param {object} stickerData - { stickerId?, stickerUrl?, stickerPack?, stickerName? }
 * @throws {Error} nếu dữ liệu sticker không hợp lệ
 */
function validateStickerData(stickerData) {
  if (!stickerData || typeof stickerData !== "object") {
    throw new Error("sticker data must be a non-null object");
  }
  if (!stickerData.stickerId && !stickerData.stickerUrl) {
    throw new Error("stickerId or stickerUrl is required for sticker messages");
  }
  // stickerUrl nếu có phải là URL hợp lệ
  if (stickerData.stickerUrl) {
    try {
      new URL(stickerData.stickerUrl);
    } catch {
      throw new Error("stickerUrl must be a valid URL");
    }
  }
}

/**
 * Validate dữ liệu emoji.
 * Emoji hợp lệ phải là chuỗi Unicode emoji (ít nhất 1 ký tự).
 * @param {string} content - chuỗi emoji
 * @throws {Error} nếu dữ liệu emoji không hợp lệ
 */
function validateEmojiData(content) {
  if (!content || typeof content !== "string" || !content.trim()) {
    throw new Error("emoji content is required and must be a non-empty string");
  }
  // Cho phép 1 emoji đơn hoặc chuỗi emoji (VD: "👍" hoặc "🎉🎊")
  // Chỉ cần non-empty string là đủ, không cần kiểm tra unicode sâu
}
async function enrichSenderInfo(senderId) {
  try {
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
  } catch {
    return { senderDisplayName: String(senderId), senderAvatarUrl: null };
  }
}

async function saveMessage(payload) {
  // ── Validate ──────────────────────────────────────────────
  if (!payload.conversationId) {
    throw new Error("conversationId is required");
  }
  if (!payload.senderId) {
    throw new Error("senderId is required");
  }

  const contentType = normalizeContentType(payload.contentType);

  // Emoji và sticker KHÔNG bắt buộc payload.content (chúng dùng sticker metadata riêng)
  if (contentType === "text" || contentType === "file") {
    if (!payload.content || !String(payload.content).trim()) {
      throw new Error("content is required for text/file messages");
    }
  }

  // Validate sticker metadata
  if (contentType === "sticker") {
    validateStickerData(payload.stickerData || {});
    // content của sticker = tên/ID để hiển thị, không dùng trim() rỗng
    if (!payload.content) {
      payload.content =
        payload.stickerData?.stickerId ||
        payload.stickerData?.stickerName ||
        "[sticker]";
    }
  }

  // Validate emoji
  if (contentType === "emoji") {
    validateEmojiData(payload.content);
  }

  const createdAt = new Date().toISOString();
  const id = Date.now();

  const newMessage = {
    id,
    senderId: payload.senderId,
    contentType,
    content: String(payload.content || "").trim(),
    // stickerData chỉ tồn tại khi contentType === "sticker"
    ...(contentType === "sticker" && payload.stickerData
      ? { stickerData: { ...payload.stickerData } }
      : {}),
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
    ...(newMessage.stickerData ? { stickerData: newMessage.stickerData } : {}),
    attachments: newMessage.attachments,
    reactions: newMessage.reactions,
    createdAt: newMessage.createdAt,
  };
}

async function getMessagesForConversation(conversationId, currentUserId) {
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

  // Filter out messages this user has hidden via "delete for me"
  let messages = res.Item.messages;
  if (currentUserId) {
    messages = messages.filter(
      (msg) => !msg.deletedFor?.map(String).includes(String(currentUserId)),
    );
  }

  // Sort by createdAt ascending
  messages = messages.slice().sort((a, b) => {
    const aTime = a.createdAt || "";
    const bTime = b.createdAt || "";
    return aTime.localeCompare(bTime);
  });

  // Enrich mỗi tin nhắn với displayName/avatarUrl của người gửi
  const enriched = await Promise.all(
    messages.map(async (msg) => {
      const info = await enrichSenderInfo(msg.senderId);
      return {
        id: msg.id,
        conversationId,
        senderId: msg.senderId,
        contentType: msg.contentType,
        content: msg.content,
        ...(msg.stickerData ? { stickerData: msg.stickerData } : {}),
        attachments: msg.attachments || null,
        reactions: msg.reactions || null,
        createdAt: msg.createdAt,
        senderDisplayName: info.senderDisplayName,
        senderAvatarUrl: info.senderAvatarUrl,
      };
    }),
  );

  return enriched;
}

function resolveAttachmentType(mimetype) {
  if (!mimetype) return "file";
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.startsWith("audio/")) return "voice";
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

  const fileKey = `messages/${Date.now()}-${randomUUID()}-${sanitizeFilename(file.originalname)}`;

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
  const groupId = data.group_id || data.groupId || data.roomId || data.conversationId || null;

  if (!senderId) {
    throw new Error("sender_id is required");
  }
  if (!receiverId && !channelId && !groupId) {
    throw new Error("receiver_id, channel_id, or group_id is required");
  }
  if (!data.attachment || !data.attachment.url) {
    throw new Error("attachment metadata is required");
  }

  const conversationId = groupId
    ? groupId
    : channelId
    ? `channel:${channelId}`
    : `dm:${[String(senderId), String(receiverId)].sort((a, b) => Number(a) - Number(b)).join(":")}`;

  const attachmentType = resolveAttachmentType(data.attachment.mimetype);
  const messageType = attachmentType === "voice" ? "voice" : attachmentType === "video" ? "video" : "file";
  const persistedMessageId = randomUUID();
  const createdAt = new Date().toISOString();

  const fileMessage = {
    id: persistedMessageId,
    senderId,
    contentType: messageType,
    content: data.attachment.originalname || "[file]",
    attachments: [
      {
        url: data.attachment.url,
        type: attachmentType,
        size: data.attachment.size,
      },
    ],
    reactions: null,
    createdAt,
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
    id: persistedMessageId,
    message_id: persistedMessageId,
    conversation_id: conversationId,
    sender_id: senderId,
    receiver_id: receiverId,
    channel_id: channelId,
    attachments: [
      {
        url: data.attachment.url,
        type: attachmentType,
        size: data.attachment.size,
      },
    ],
    type: messageType,
    created_at: createdAt,
  };

  return item;
}
async function saveStickerMessage(data) {
  const senderId = data.senderId;
  const conversationId = data.conversationId;

  if (!senderId) {
    throw new Error("senderId is required");
  }
  if (!conversationId) {
    throw new Error("conversationId is required");
  }
  validateStickerData(data.stickerData || {});

  return saveMessage({
    senderId,
    conversationId,
    contentType: "sticker",
    content:
      data.stickerData?.stickerName ||
      data.stickerData?.stickerId ||
      "[sticker]",
    stickerData: data.stickerData,
  });
}
module.exports = {
  saveMessage,
  saveStickerMessage,
  getMessagesForConversation,
  uploadFileToS3,
  saveFileMessage,
};
