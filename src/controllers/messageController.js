const messageService = require('../services/messageService');

async function getMessagesForConversation(req, res) {
  try {
    const messages = await messageService.getMessagesForConversation(req.params.conversationId);
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

module.exports = {
  getMessagesForConversation,
  sendMessage
};
