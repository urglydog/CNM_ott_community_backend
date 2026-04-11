const { generateToken04 } = require('../../common/utils/zegoToken');

function getToken(req, res) {
  try {
    const userID = (req.query.userID || '').toString().trim();
    if (!userID) {
      return res.status(400).json({ message: 'userID is required' });
    }

    const appID = Number(process.env.ZEGO_APP_ID);
    const serverSecret = process.env.ZEGO_SERVER_SECRET;

    if (!appID || !serverSecret) {
      return res.status(500).json({ message: 'ZEGO config is missing' });
    }

    const effectiveTimeInSeconds = Number(req.query.expired_ts) || 3600;
    const token = generateToken04(appID, userID, serverSecret, effectiveTimeInSeconds, '');

    return res.json({
      appID,
      token,
      userID,
      expiredIn: effectiveTimeInSeconds
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

module.exports = {
  getToken
};
