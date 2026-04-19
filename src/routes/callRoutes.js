const express = require('express');
const router = express.Router();

const callController = require('../modules/chat/callController');

router.get('/token', callController.getCallToken);

module.exports = router;
