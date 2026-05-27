const userService = require('./userService');
const friendService = require('./friendService');

const QR_TYPE = 'OTT_FR';
const VERSION = '1';

function encodeQRData(userId) {
  return `${QR_TYPE}|${VERSION}|${userId}`;
}

function decodeQRData(qrData) {
  if (!qrData || typeof qrData !== 'string') {
    return null;
  }

  const parts = qrData.split('|');
  if (parts.length !== 3) {
    return null;
  }

  const [type, version, userId] = parts;

  if (type !== QR_TYPE || version !== VERSION) {
    return null;
  }

  if (!userId || userId.trim() === '') {
    return null;
  }

  return userId.trim();
}

async function getUserQRInfo(userId) {
  const user = await userService.getUserById(userId);
  if (!user) {
    const error = new Error('Không tìm thấy người dùng');
    error.statusCode = 404;
    throw error;
  }

  const qrData = encodeQRData(user.userId);

  return {
    userId: user.userId,
    displayName: user.display_name || user.username,
    avatarUrl: user.avatar_url || null,
    qrData: qrData,
  };
}

async function sendFriendRequestByQR(senderId, qrData) {
  const receiverId = decodeQRData(qrData);

  if (!receiverId) {
    const error = new Error('Mã QR không hợp lệ hoặc đã hết hạn');
    error.statusCode = 400;
    throw error;
  }

  if (senderId === receiverId) {
    const error = new Error('Bạn không thể kết bạn với chính mình');
    error.statusCode = 400;
    throw error;
  }

  const receiver = await userService.getUserById(receiverId);
  if (!receiver) {
    const error = new Error('Người dùng không tồn tại');
    error.statusCode = 404;
    throw error;
  }

  const result = await friendService.sendFriendRequest(senderId, receiverId);

  return {
    ...result,
    receiver: {
      userId: receiver.userId,
      displayName: receiver.display_name || receiver.username,
      avatarUrl: receiver.avatar_url || null,
    },
  };
}

module.exports = {
  encodeQRData,
  decodeQRData,
  getUserQRInfo,
  sendFriendRequestByQR,
};
