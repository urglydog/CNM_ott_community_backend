const express = require('express');
const router = express.Router();

const callController = require('../controllers/callController');

router.get('/token', callController.getCallToken);

module.exports = router;
