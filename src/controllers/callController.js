const { generateToken04 } = require('../utils/zegoToken');

async function getCallToken(req, res) {
  try {
    const userID = (req.query.userID || '').toString().trim();
    if (!userID) {
      return res.status(400).json({ message: 'Thieu userID' });
    }

    // Important: appID must be a number for Zego token generation.
    const appID = Number(process.env.ZEGO_APP_ID);
    const serverSecret = process.env.ZEGO_SERVER_SECRET;
    const effectiveTimeInSeconds = 3600;

    if (!appID || !serverSecret) {
      return res.status(500).json({ message: 'ZEGO config is missing' });
    }

    // Empty payload => room-agnostic (universal) token.
    const payload = '';
    const token = generateToken04(appID, userID, serverSecret, effectiveTimeInSeconds, payload);

    return res.status(200).json({
      token,
      appID,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

module.exports = {
  getCallToken,
  // Backward compatibility for existing imports/routes.
  getToken: getCallToken,
};
