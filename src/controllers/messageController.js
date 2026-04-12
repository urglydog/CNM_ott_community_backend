const messageService = require("../services/messageService");

function buildMessagePayload(reqBody, overrides = {}) {
  return {
    ...reqBody,
    ...overrides,
  };
}

async function getMessagesForConversation(req, res) {
  try {
    const messages = await messageService.getMessagesForConversation(
      req.params.conversationId,
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
    const messages =
      await messageService.getMessagesForConversation(conversationId);
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

async function sendChannelMessage(req, res) {
  try {
    const payload = buildMessagePayload(req.body, {
      channelId:
        req.body.channelId || req.body.conversationId?.replace(/^channel:/, ""),
    });

    const message = await messageService.saveMessage(payload);
    res.status(201).json(message);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function sendDirectMessage(req, res) {
  try {
    const payload = buildMessagePayload(req.body, {
      directChatId:
        req.body.directChatId ||
        req.body.conversationId?.replace(/^direct:/, ""),
    });

    const message = await messageService.saveMessage(payload);
    res.status(201).json(message);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

module.exports = {
  getMessagesForConversation,
  getMessagesForChannel,
  sendMessage,
  sendChannelMessage,
  sendDirectMessage,
};
