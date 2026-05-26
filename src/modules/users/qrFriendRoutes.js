const express = require('express');
const router = express.Router();

const qrFriendController = require('./qrFriendController');
const authMiddleware = require('../../common/middlewares/authMiddleware');

router.get('/qr-info/:userId', qrFriendController.getQRInfo);
router.post('/request-by-qr', authMiddleware, qrFriendController.sendFriendRequestByQR);

module.exports = router;
