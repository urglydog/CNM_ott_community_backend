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
    // Chấp nhận replyTo từ body nếu có
    const messageData = {
      ...req.body,
      // replyTo sẽ được xử lý trong messageService.saveMessage
    };
    const message = await messageService.saveMessage(messageData);
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
 * Body: { senderId, conversationId, stickerData: { stickerId, stickerUrl, stickerPack, stickerName }, replyTo? }
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
      replyTo: req.body.replyTo || null,
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
 * Body: { senderId, conversationId, content (emoji string), replyTo? }
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
      replyTo: req.body.replyTo || null,
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
    const groupId = req.body.group_id || req.body.groupId || req.body.roomId || req.body.conversationId || null;

    const uploadedFile = await messageService.uploadFileToS3(req.file);

    const savedMessage = await messageService.saveFileMessage({
      sender_id: senderId,
      receiver_id: receiverId,
      channel_id: channelId,
      group_id: groupId,
      attachment: uploadedFile,
    });

    const conversationId =
      savedMessage.conversationId ||
      savedMessage.conversation_id ||
      groupId ||
      (channelId
        ? `channel:${channelId}`
        : `dm:${[String(senderId), String(receiverId)].sort((a, b) => Number(a) - Number(b)).join(":")}`);

    const senderInfo = await messageService.enrichSenderInfo(senderId);

    const messagePayload = {
      id: savedMessage.id || savedMessage.message_id || Date.now(),
      conversationId,
      senderId: savedMessage.sender_id || senderId,
      senderDisplayName: senderInfo.senderDisplayName,
      senderAvatarUrl: senderInfo.senderAvatarUrl,
      contentType: savedMessage.contentType || savedMessage.type || "file",
      content: req.file.originalname,
      attachments: savedMessage.attachments || [
        {
          url: uploadedFile.url,
          type: uploadedFile.mimetype?.startsWith("image/") ? "image" : "file",
          size: uploadedFile.size,
        },
      ],
      createdAt: savedMessage.created_at || savedMessage.createdAt || new Date().toISOString(),
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

/**
 * Gửi tin nhắn vị trí tĩnh (Current Location).
 * Body: { conversationId, locationData: { lat: number, lng: number, label?: string }, replyTo? }
 *
 * Luồng:
 *  1. Validate lat/lng từ client (navigator.geolocation.getCurrentPosition)
 *  2. Lưu tin nhắn với contentType="location" vào DynamoDB
 *  3. Broadcast qua Socket.io để người nhận thấy ngay
 */
async function sendLocationMessage(req, res) {
  try {
    const senderId = req.body.senderId || req.user?.userId || req.user?.id;
    const conversationId = req.body.conversationId || req.body.groupId;
    const locationData = req.body.locationData || req.body.location; // { lat, lng, label? }

    if (!senderId) {
      return res.status(400).json({ message: "senderId is required" });
    }
    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }
    // Kiểm tra locationData có hợp lệ không
    if (
      !locationData ||
      typeof locationData.lat !== "number" ||
      typeof locationData.lng !== "number"
    ) {
      return res.status(400).json({
        message: "locationData với lat và lng (number) là bắt buộc",
      });
    }

    // Lưu tin nhắn vị trí vào DB
    const message = await messageService.saveMessage({
      senderId,
      conversationId,
      contentType: "location",
      content: locationData.label || `📍 ${locationData.lat.toFixed(6)}, ${locationData.lng.toFixed(6)}`,
      locationData: {
        lat: locationData.lat,
        lng: locationData.lng,
        label: locationData.label || null,
      },
      replyTo: req.body.replyTo || null,
    });

    // Broadcast realtime cho tất cả thành viên trong phòng
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
 * Bắt đầu phên live location — tạo tin nhắn với isLive: true.
 * Body: { conversationId, locationData: { lat, lng, label? } }
 * Trả về tin nhắn + messageId để frontend lưu lại và dùng khi dừng.
 */
async function startLiveLocationMessage(req, res) {
  try {
    const senderId = req.body.senderId || req.user?.userId || req.user?.id;
    const conversationId = req.body.conversationId || req.body.groupId;
    const locationData = req.body.locationData || req.body.location; // { lat, lng, label? }

    if (!senderId) {
      return res.status(400).json({ message: "senderId is required" });
    }
    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }
    if (
      !locationData ||
      typeof locationData.lat !== "number" ||
      typeof locationData.lng !== "number"
    ) {
      return res.status(400).json({
        message: "locationData với lat và lng (number) là bắt buộc",
      });
    }

    // Lưu tin nhắn live location vào DB
    const message = await messageService.saveMessage({
      senderId,
      conversationId,
      contentType: "location",
      content: `📍 ${locationData.label || "Vị trí trực tiếp"}`,
      locationData: {
        lat: locationData.lat,
        lng: locationData.lng,
        label: locationData.label || null,
        isLive: true,
        liveUntil: null, // sẽ cập nhật khi dừng
      },
      replyTo: req.body.replyTo || null,
    });

    // Broadcast realtime cho tất cả thành viên trong phòng
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
 * Dừng phên live location — cập nhật isLive: false, liveUntil: now.
 * PATCH /api/messages/location/live/:messageId/stop
 * Body: { conversationId }
 */
async function stopLiveLocationMessage(req, res) {
  try {
    const { messageId } = req.params;
    const conversationId = req.body.conversationId;

    if (!messageId) {
      return res.status(400).json({ message: "messageId is required" });
    }
    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }

    const stoppedAt = new Date().toISOString();
    const updatedMsg = await messageService.stopLiveLocationMessage(
      conversationId,
      messageId,
      stoppedAt
    );

    if (!updatedMsg) {
      return res.status(404).json({ message: "Không tìm thấy tin nhắn live location" });
    }

    // Broadcast cập nhật tới cả 2 phía qua socket
    const io = req.app.get("socketio");
    if (io) {
      io.to(conversationId).emit("live_location_message_stopped", {
        conversationId,
        messageId: String(messageId),
        locationData: updatedMsg.locationData,
      });
    }

    res.json({
      message: "Live location đã được dừng",
      data: {
        id: updatedMsg.id,
        conversationId,
        locationData: updatedMsg.locationData,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
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
  sendLocationMessage,
  startLiveLocationMessage,
  stopLiveLocationMessage,
};
