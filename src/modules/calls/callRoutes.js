const express = require('express');
const router = express.Router();
const callController = require('./callController');
const zegoWebhookController = require('./zegoWebhookController');

// Route này nằm TỰ DO, KHÔNG được bọc bởi JWT middleware (quan trọng)
router.post('/webhook/zegocloud', zegoWebhookController.handleZegoWebhook);

// Các API cho call (nếu route cha đã dùng auth thì route này auth, 
// nhưng thường webhook nên đứng ở file riêng hoặc đảm bảo route app không bọc auth cho path webhook)
router.get('/token', callController.getCallToken);

module.exports = router;
