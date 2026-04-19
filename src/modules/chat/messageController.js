const messageService = require("./messageService");

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
      id: savedMessage.message_id || Date.now(),
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
  sendFileMessage,
};
