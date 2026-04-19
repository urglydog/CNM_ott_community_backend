const express = require('express');
const router = express.Router();

const friendController = require('../modules/users/friendController');
const authMiddleware = require('../middlewares/authMiddleware');

// Tất cả các route đều cần xác thực JWT
router.get('/', authMiddleware, friendController.getFriends);
router.post('/request', authMiddleware, friendController.sendFriendRequest);
router.put('/accept', authMiddleware, friendController.acceptFriendRequest);
router.put('/reject', authMiddleware, friendController.rejectFriendRequest);
router.get('/pending', authMiddleware, friendController.getPendingRequests);

module.exports = router;
