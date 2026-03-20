const express = require('express');
const router = express.Router();

const uploadController = require('../controllers/uploadController');

router.post('/presigned-url', uploadController.getPresignedUploadUrl);

module.exports = router;
