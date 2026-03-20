const express = require('express');
const router = express.Router();

const messageController = require('../controllers/messageController');

router.get('/conversations/:conversationId', messageController.getMessagesForConversation);
// shortcut: lấy messages theo channelId, dùng conversationId dạng "channel:id"
router.get('/channel/:channelId', messageController.getMessagesForChannel);

router.post('/', messageController.sendMessage);

module.exports = router;
