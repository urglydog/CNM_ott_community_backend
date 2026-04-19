const express = require('express');
const router = express.Router();
const multer = require('multer');

const uploadController = require('./uploadController');
const authMiddleware = require('../../common/middlewares/authMiddleware');

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: 5 * 1024 * 1024,
	},
});

router.post('/presigned-url', uploadController.getPresignedUploadUrl);
router.post('/direct', authMiddleware, upload.single('file'), uploadController.uploadDirect);
router.get('/view-url', authMiddleware, uploadController.getPresignedViewUrl);

module.exports = router;
