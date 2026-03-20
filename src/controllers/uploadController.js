const uploadService = require('../services/uploadService');

async function getPresignedUploadUrl(req, res) {
  try {
    const { keyPrefix, contentType } = req.body;
    const result = await uploadService.getPresignedUploadUrl({ keyPrefix, contentType });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

module.exports = { getPresignedUploadUrl };
