const botService = require("./botService");
const { getIO } = require("../../socket/socketHandler");
const { emitToUserSockets } = require("../../socket/socketUserRegistry");
const messageService = require("../messages/messageService");
const { notifyMessageCreated } = require("../notifications/notificationService");

function isTemporaryModelError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  return status === 429 || status === 503;
}

function buildTemporaryUnavailableReply() {
  return "BotAI đang bận hoặc tạm quá tải nên chưa xử lý được yêu cầu này. Bạn thử lại sau ít phút giúp mình nhé.";
}

function resolveUserId(req) {
  return (
    req.user?.userId ||
    req.user?.id ||
    req.body?.userId ||
    req.query?.userId ||
    ""
  );
}

async function emitBotStatus({ userId, conversationId, eventName, payload }) {
  const io = getIO();
  if (!io) {
    return;
  }

  const eventPayload = {
    ...payload,
    conversationId: conversationId || payload.conversationId || null,
    userId: userId || null,
    timestamp: new Date().toISOString(),
  };

  if (conversationId) {
    io.to(String(conversationId)).emit(eventName, eventPayload);
    return;
  }

  if (userId) {
    emitToUserSockets(io, userId, eventName, eventPayload);
  }
}

function isGlobalAiConversation(conversationId) {
  return String(conversationId || "").startsWith("ai-global:");
}

async function persistBotReplyToConversation({ conversationId, reply }) {
  if (!conversationId || isGlobalAiConversation(conversationId)) {
    return null;
  }

  const savedMessage = await messageService.saveMessage({
    conversationId,
    senderId: "ai-bot",
    contentType: "text",
    content: reply,
  });

  const senderInfo = await messageService.enrichSenderInfo(savedMessage.senderId);
  return {
    ...savedMessage,
    ...senderInfo,
  };
}

async function enrichChatMessage(message) {
  if (!message) {
    return null;
  }

  const senderInfo = await messageService.enrichSenderInfo(message.senderId);
  return {
    ...message,
    ...senderInfo,
  };
}

function getCreatedReminderMessages(toolCalls = []) {
  return toolCalls
    .filter(
      (toolCall) =>
        toolCall &&
        toolCall.tool === "createReminder" &&
        toolCall.ok === true &&
        toolCall.message,
    )
    .map((toolCall) => toolCall.message);
}

async function chatWithBot(req, res) {
  try {
    const userId = String(resolveUserId(req) || "").trim();
    const message = req.body?.message;
    const conversationId = String(req.body?.conversationId || "").trim();

    console.log("[botController] Incoming chatWithBot request", {
      userId: userId || null,
      conversationId: conversationId || null,
      hasMessage: Boolean(message && String(message).trim()),
      messagePreview: String(message || "").slice(0, 120),
    });

    if (!userId) {
      console.warn("[botController] Rejecting request: userId is required", {
        body: req.body,
      });
      return res.status(400).json({ message: "userId is required" });
    }

    if (!message || !String(message).trim()) {
      console.warn("[botController] Rejecting request: message is required", {
        body: req.body,
      });
      return res.status(400).json({ message: "message is required" });
    }

    const result = await botService.processChatMessage({
      userId,
      message,
      conversationId,
      onStatus: async (status, payload) => {
        await emitBotStatus({
          userId,
          conversationId,
          eventName: status,
          payload,
        });
      },
    });

    const io = req.app.get("socketio");
    const createdReminderMessages = await Promise.all(
      getCreatedReminderMessages(result.toolCalls).map((message) =>
        enrichChatMessage(message),
      ),
    );
    const hasCreatedReminderMessage = createdReminderMessages.length > 0;
    let persistedBotMessage = null;

    if (!hasCreatedReminderMessage) {
      try {
        persistedBotMessage = await persistBotReplyToConversation({
          conversationId: result.conversationId,
          reply: result.reply,
        });
      } catch (persistError) {
        console.error("[botController] failed to persist bot reply:", {
          conversationId: result.conversationId,
          message: persistError?.message || persistError,
        });
      }
    }

    for (const reminderMessage of createdReminderMessages) {
      if (io && reminderMessage) {
        io.to(reminderMessage.conversationId).emit(
          "receive_message",
          reminderMessage,
        );
      }

      if (reminderMessage) {
        try {
          await notifyMessageCreated(reminderMessage, io);
        } catch (notifyError) {
          console.error(
            "[botController] reminder notification failed:",
            notifyError.message,
          );
        }
      }
    }

    if (io && persistedBotMessage) {
      io.to(persistedBotMessage.conversationId).emit(
        "receive_message",
        persistedBotMessage,
      );
    }

    if (persistedBotMessage) {
      try {
        await notifyMessageCreated(persistedBotMessage, io);
      } catch (notifyError) {
        console.error("[botController] bot notification failed:", notifyError.message);
      }
    }

    await emitBotStatus({
      userId,
      conversationId,
      eventName: "bot_typing",
      payload: {
        stage: "done",
        status: "completed",
      },
    });

    return res.status(200).json({
      sender: result.sender,
      content: result.reply,
      reply: result.reply,
      status: result.status,
      toolCalls: result.toolCalls,
      conversationId: result.conversationId,
    });
  } catch (error) {
    console.error("[botController] chatWithBot error:", {
      message: error?.message || "Internal server error",
      stack: error?.stack || null,
      body: req.body,
    });

    if (isTemporaryModelError(error)) {
      return res.status(200).json({
        sender: "BotAI",
        content: buildTemporaryUnavailableReply(),
        reply: buildTemporaryUnavailableReply(),
        status: "temporarily_unavailable",
        toolCalls: [],
        conversationId: String(req.body?.conversationId || "").trim() || null,
      });
    }

    return res.status(500).json({
      message: error.message || "Internal server error",
    });
  }
}

module.exports = {
  chatWithBot,
};
