const qrFriendService = require('./qrFriendService');
const { notifyNewFriendRequest } = require('../../socket/socketHandler');
const userService = require('./userService');

async function getQRInfo(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ message: 'Vui lòng cung cấp userId' });
    }

    const qrInfo = await qrFriendService.getUserQRInfo(userId);
    return res.status(200).json(qrInfo);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ message: error.message });
  }
}

async function sendFriendRequestByQR(req, res) {
  try {
    const senderId = req.user?.userId;
    if (!senderId) {
      return res.status(401).json({ message: 'Chưa xác thực' });
    }

    const { qrData } = req.body;
    if (!qrData) {
      return res.status(400).json({ message: 'Vui lòng cung cấp mã QR' });
    }

    const result = await qrFriendService.sendFriendRequestByQR(senderId, qrData);

    const senderInfo = await userService.getUserById(senderId);
    if (senderInfo && result.receiver?.userId) {
      notifyNewFriendRequest(result.receiver.userId, senderInfo);
    }

    return res.status(201).json({
      message: 'Đã gửi lời mời kết bạn',
      data: result,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ message: error.message });
  }
}

module.exports = {
  getQRInfo,
  sendFriendRequestByQR,
};
