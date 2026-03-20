const express = require('express');
const router = express.Router();

const channelController = require('../controllers/channelController');

// Lấy danh sách channel trong một group
router.get('/group/:groupId', channelController.getChannelsByGroup);

// Lấy chi tiết một channel
router.get('/:channelId', channelController.getChannelById);

module.exports = router;
