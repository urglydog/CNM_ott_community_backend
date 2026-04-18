const uploadService = require('./uploadService');

async function getPresignedUploadUrl(req, res) {
  try {
    const { keyPrefix, contentType } = req.body;
    const result = await uploadService.getPresignedUploadUrl({ keyPrefix, contentType });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function uploadDirect(req, res) {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'Vui lòng chọn tệp cần tải lên' });
    }

    const { keyPrefix } = req.body || {};
    const result = await uploadService.uploadBufferDirect({
      keyPrefix,
      contentType: req.file.mimetype,
      buffer: req.file.buffer,
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

async function getPresignedViewUrl(req, res) {
  try {
    const key = req.query?.key || req.body?.key;
    const url = req.query?.url || req.body?.url;
    const result = await uploadService.getPresignedViewUrl({ key, url });
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}

module.exports = { getPresignedUploadUrl, uploadDirect, getPresignedViewUrl };
