const messageService = require("./messageService");
const { notifyMessageCreated } = require("../notifications/notificationService");

async function getMessagesForConversation(req, res) {
  try {
    const currentUserId = req.user?.userId ?? req.user?.id ?? null;
    const messages = await messageService.getMessagesForConversation(
      req.params.conversationId,
      currentUserId,
    );
    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getMessagesForChannel(req, res) {
  try {
    const channelId = req.params.channelId;
    const conversationId = `channel:${channelId}`;
    const currentUserId = req.user?.userId ?? req.user?.id ?? null;
    const messages = await messageService.getMessagesForConversation(
      conversationId,
      currentUserId,
    );
    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function sendMessage(req, res) {
  try {
    const message = await messageService.saveMessage(req.body);
    const io = req.app.get("socketio");
    if (io) {
      io.to(message.conversationId).emit("receive_message", message);
    }
    await notifyMessageCreated(message, io);
    res.status(201).json(message);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function searchMessages(req, res) {
  try {
    const currentUserId = req.user?.userId ?? req.user?.id ?? null;
    const result = await messageService.searchMessagesInConversation({
      conversationId: req.query.conversationId,
      keyword: req.query.keyword,
      senderId: req.query.senderId,
      fromDate: req.query.fromDate || req.query.from,
      toDate: req.query.toDate || req.query.to,
      limit: req.query.limit,
      currentUserId,
    });

    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function searchMessagesGlobal(req, res) {
  try {
    const currentUserId = req.user?.userId ?? req.user?.id ?? null;
    const result = await messageService.searchMessagesForUserGlobal({
      keyword: req.query.keyword,
      fromDate: req.query.fromDate || req.query.from,
      toDate: req.query.toDate || req.query.to,
      limit: req.query.limit,
      currentUserId,
    });

    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

/**
 * Gửi tin nhắn sticker.
 * Body: { senderId, conversationId, stickerData: { stickerId, stickerUrl, stickerPack, stickerName } }
 */
async function sendStickerMessage(req, res) {
  try {
    const senderId = req.body.senderId || req.user?.userId || req.user?.id;
    const conversationId = req.body.conversationId;

    if (!senderId) {
      return res.status(400).json({ message: "senderId is required" });
    }
    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }

    const stickerData = req.body.stickerData;
    if (!stickerData) {
      return res.status(400).json({ message: "stickerData is required" });
    }
    if (!stickerData.stickerId && !stickerData.stickerUrl) {
      return res
        .status(400)
        .json({
          message: "stickerId or stickerUrl is required in stickerData",
        });
    }

    const message = await messageService.saveMessage({
      senderId,
      conversationId,
      contentType: "sticker",
      content: stickerData.stickerName || stickerData.stickerId || "[sticker]",
      stickerData,
    });

    // Broadcast real-time
    const io = req.app.get("socketio");
    if (io) {
      io.to(conversationId).emit("receive_message", message);
    }
    await notifyMessageCreated(message, io);

    res.status(201).json(message);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

/**
 * Gửi tin nhắn emoji.
 * Body: { senderId, conversationId, content (emoji string) }
 */
async function sendEmojiMessage(req, res) {
  try {
    const senderId = req.body.senderId || req.user?.userId || req.user?.id;
    const conversationId = req.body.conversationId;

    if (!senderId) {
      return res.status(400).json({ message: "senderId is required" });
    }
    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }
    if (!req.body.content || !String(req.body.content).trim()) {
      return res.status(400).json({ message: "content (emoji) is required" });
    }

    const message = await messageService.saveMessage({
      senderId,
      conversationId,
      contentType: "emoji",
      content: req.body.content.trim(),
    });

    // Broadcast real-time
    const io = req.app.get("socketio");
    if (io) {
      io.to(conversationId).emit("receive_message", message);
    }
    await notifyMessageCreated(message, io);

    res.status(201).json(message);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function sendFileMessage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "file is required" });
    }

    const senderId =
      req.body.sender_id || req.body.senderId || req.user?.userId;
    const receiverId = req.body.receiver_id || req.body.receiverId || null;
    const channelId = req.body.channel_id || req.body.channelId || null;

    const uploadedFile = await messageService.uploadFileToS3(req.file);

    const savedMessage = await messageService.saveFileMessage({
      sender_id: senderId,
      receiver_id: receiverId,
      channel_id: channelId,
      attachment: uploadedFile,
    });

    const conversationId =
      savedMessage.conversationId ||
      savedMessage.conversation_id ||
      (channelId
        ? `channel:${channelId}`
        : `dm:${[String(senderId), String(receiverId)].sort((a, b) => Number(a) - Number(b)).join(":")}`);

    const messagePayload = {
      id: savedMessage.id || savedMessage.message_id || Date.now(),
      conversationId,
      senderId: savedMessage.sender_id || senderId,
      contentType: savedMessage.type || "file",
      content: req.file.originalname,
      attachments: savedMessage.attachments || [
        {
          url: uploadedFile.url,
          type: uploadedFile.mimetype?.startsWith("image/") ? "image" : "file",
          size: uploadedFile.size,
        },
      ],
      createdAt: savedMessage.created_at || new Date().toISOString(),
    };

    const io = req.app.get("socketio");
    if (io) {
      io.to(conversationId).emit("receive_message", messagePayload);
    }
    await notifyMessageCreated(messagePayload, io);

    return res.status(201).json({
      message: "File message sent successfully",
      data: messagePayload,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

module.exports = {
  getMessagesForConversation,
  getMessagesForChannel,
  sendMessage,
  searchMessages,
  searchMessagesGlobal,
  sendFileMessage,
  sendStickerMessage,
  sendEmojiMessage,
};
