const friendService = require('./friendService');
const { notifyNewFriendRequest, notifyFriendAccepted } = require('../../socket/socketHandler');
const userService = require('./userService');

async function sendFriendRequest(req, res) {
  try {
    const senderId = req.user?.userId;
    if (!senderId) {
      return res.status(401).json({ message: 'Chưa xác thực' });
    }

    const { receiverId } = req.body;
    if (!receiverId) {
      return res.status(400).json({ message: 'Vui lòng cung cấp receiverId' });
    }

    const result = await friendService.sendFriendRequest(senderId, receiverId);

    const senderInfo = await userService.getUserById(senderId);
    if (senderInfo) {
      notifyNewFriendRequest(receiverId, senderInfo);
    }

    return res.status(201).json({
      message: 'Đã gửi lời mời kết bạn',
      data: result
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ message: error.message });
  }
}

async function acceptFriendRequest(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Chưa xác thực' });
    }

    const { requestId } = req.body;
    if (!requestId) {
      return res.status(400).json({ message: 'Vui lòng cung cấp requestId' });
    }

    const result = await friendService.acceptFriendRequest(requestId, userId);

    const senderInfo = await userService.getUserById(result.sender_id);
    if (senderInfo) {
      notifyFriendAccepted(result.sender_id, senderInfo);
    }

    return res.status(200).json({
      message: 'Đã chấp nhận lời mời kết bạn',
      data: result
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ message: error.message });
  }
}

async function rejectFriendRequest(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Chưa xác thực' });
    }

    const { requestId } = req.body;
    if (!requestId) {
      return res.status(400).json({ message: 'Vui lòng cung cấp requestId' });
    }

    const result = await friendService.rejectFriendRequest(requestId, userId);
    return res.status(200).json({
      message: 'Đã từ chối lời mời kết bạn',
      data: result
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ message: error.message });
  }
}

async function getPendingRequests(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Chưa xác thực' });
    }

    const requests = await friendService.getPendingRequests(userId);
    return res.status(200).json({
      message: 'Đã lấy danh sách lời mời kết bạn đang chờ',
      data: requests,
      count: requests.length
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

async function getFriends(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Chưa xác thực' });
    }

    const friends = await friendService.getFriends(userId);
    return res.status(200).json({
      message: 'Đã lấy danh sách bạn bè',
      data: friends,
      count: friends.length
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

async function updateNickname(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Chưa xác thực' });

    const { friendshipId, nickname } = req.body;
    
    if (!friendshipId) return res.status(400).json({ message: 'friendshipId là bắt buộc' });

    const result = await friendService.updateNickname(friendshipId, userId, nickname || null);
    return res.status(200).json({ message: 'Đã cập nhật tên gợi nhớ', data: result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function updateChatBackground(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Chưa xác thực' });

    const { friendshipId, bgUrl, bothSides } = req.body;
    if (!friendshipId) return res.status(400).json({ message: 'friendshipId là bắt buộc' });

    const result = await friendService.updateChatBackground(userId, friendshipId, bgUrl || null, !!bothSides);
    return res.status(200).json({ message: 'Đã cập nhật hình nền chat', data: result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function getChatBackground(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Chưa xác thực' });

    const { friendshipId } = req.params;
    if (!friendshipId) return res.status(400).json({ message: 'friendshipId là bắt buộc' });

    const bgUrl = await friendService.getChatBackground(userId, friendshipId);
    return res.status(200).json({ chatBgUrl: bgUrl });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function unfriend(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Chưa xác thực' });
    }

    const { friendshipId } = req.params;
    if (!friendshipId) {
      return res.status(400).json({ message: 'friendshipId là bắt buộc' });
    }

    const result = await friendService.unfriend(friendshipId, userId);
    return res.status(200).json({
      message: 'Đã hủy kết bạn thành công',
      data: result
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ message: error.message });
  }
}

module.exports = {
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  getPendingRequests,
  getFriends,
  updateNickname,
  updateChatBackground,
  getChatBackground,
  unfriend,
};
