const {
  registerDeviceToken,
  removeDeviceToken,
  getFirebasePublicConfig,
} = require("./notificationService");

async function getFirebaseConfig(req, res) {
  res.json(getFirebasePublicConfig());
}

async function registerDevice(req, res) {
  try {
    const userId = req.user?.userId ?? req.user?.id ?? req.body.userId;
    const token = req.body?.token;

    const record = await registerDeviceToken(userId, token, {
      platform: req.body?.platform,
      deviceName: req.body?.deviceName,
    });

    res.json({
      message: "Device token registered",
      data: record,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function removeDevice(req, res) {
  try {
    const userId = req.user?.userId ?? req.user?.id ?? req.body.userId;
    const token = req.body?.token;
    const removed = await removeDeviceToken(userId, token);

    res.json({
      message: removed ? "Device token removed" : "Device token not found",
      removed,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

module.exports = {
  getFirebaseConfig,
  registerDevice,
  removeDevice,
};