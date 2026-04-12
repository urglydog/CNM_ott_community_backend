const express = require('express');
const router = express.Router();

const uploadController = require('./uploadController');

router.post('/presigned-url', uploadController.getPresignedUploadUrl);

module.exports = router;
