const express = require('express');
const router = express.Router();
const callController = require('./callController');

router.get('/token', callController.getToken);

module.exports = router;
