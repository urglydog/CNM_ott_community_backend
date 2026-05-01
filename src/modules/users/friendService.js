const { ddbDocClient } = require('../../config/awsConfig');
const { PutCommand, GetCommand, UpdateCommand, DeleteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const FRIENDS_TABLE = process.env.DDB_FRIENDSHIPS_TABLE || 'ott_friendships';

/* ─── helpers ─────────────────────────────────────────────────────────────── */

async function findExistingRecord(senderId, receiverId) {
  const uid = String(senderId);
  const rid = String(receiverId);

  const res = await ddbDocClient.send(new ScanCommand({
    TableName: FRIENDS_TABLE,
    FilterExpression: '((sender_id = :s AND receiver_id = :r) OR (sender_id = :r AND receiver_id = :s))',
    ExpressionAttributeValues: {
      ':s': uid,
      ':r': rid
    }
  }));

  return (res.Items && res.Items.length > 0) ? res.Items[0] : null;
}

async function putOrUpdateFriendship(item) {
  await ddbDocClient.send(new PutCommand({
    TableName: FRIENDS_TABLE,
    Item: item
  }));
}

async function updateFriendshipStatus(friendshipId, userId, status) {
  await ddbDocClient.send(new UpdateCommand({
    TableName: FRIENDS_TABLE,
    Key: { friendshipId: String(friendshipId) },
    UpdateExpression: 'SET #st = :s, updated_at = :u',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':s': status,
      ':u': new Date().toISOString()
    }
  }));
}

async function getFriendshipByFriendshipId(friendshipId) {
  const res = await ddbDocClient.send(new GetCommand({
    TableName: FRIENDS_TABLE,
    Key: { friendshipId: String(friendshipId) }
  }));
  return res.Item || null;
}

/* ─── public functions ─────────────────────────────────────────────────────── */

async function sendFriendRequest(senderId, receiverId) {
  const sender = String(senderId);
  const receiver = String(receiverId);

  if (sender === receiver) {
    const err = new Error('Không thể gửi lời mời kết bạn cho chính mình');
    err.statusCode = 400;
    throw err;
  }

  // Kiểm tra bản ghi đã tồn tại (theo cả 2 chiều)
  const existing = await findExistingRecord(sender, receiver);

  if (existing) {
    if (existing.status === 'accepted') {
      const err = new Error('Hai tài khoản đã là bạn bè');
      err.statusCode = 409;
      throw err;
    }
    if (existing.status === 'pending') {
      const err = new Error('Lời mời kết bạn đã tồn tại');
      err.statusCode = 409;
      throw err;
    }
    if (existing.status === 'rejected') {
      // Cập nhật lại thành pending
      await updateFriendshipStatus(existing.friendshipId, sender, 'pending');
      return {
        id: existing.friendshipId,
        sender_id: sender,
        receiver_id: receiver,
        status: 'pending'
      };
    }
  }

  const friendshipId = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  const item = {
    friendshipId,
    sender_id: sender,
    receiver_id: receiver,
    status: 'pending',
    created_at: now,
    updated_at: now
  };

  await putOrUpdateFriendship(item);

  return {
    id: friendshipId,
    sender_id: sender,
    receiver_id: receiver,
    status: 'pending'
  };
}

async function acceptFriendRequest(friendshipId, userId) {
  const rec = await getFriendshipByFriendshipId(friendshipId);

  if (!rec) {
    const err = new Error('Không tìm thấy lời mời kết bạn hoặc bạn không có quyền thực hiện');
    err.statusCode = 404;
    throw err;
  }

  if (String(rec.receiver_id) !== String(userId)) {
    const err = new Error('Không tìm thấy lời mời kết bạn hoặc bạn không có quyền thực hiện');
    err.statusCode = 404;
    throw err;
  }

  if (rec.status !== 'pending') {
    const err = new Error(`Không thể chấp nhận lời mời có trạng thái: ${rec.status}`);
    err.statusCode = 400;
    throw err;
  }

  await updateFriendshipStatus(friendshipId, userId, 'accepted');

  return {
    id: friendshipId,
    sender_id: rec.sender_id,
    receiver_id: rec.receiver_id,
    status: 'accepted',
    sender_info: {
      id: rec.sender_id,
      display_name: '',
      username: '',
      avatar_url: null
    }
  };
}

async function rejectFriendRequest(friendshipId, userId) {
  const rec = await getFriendshipByFriendshipId(friendshipId);

  if (!rec) {
    const err = new Error('Không tìm thấy lời mời kết bạn hoặc bạn không có quyền thực hiện');
    err.statusCode = 404;
    throw err;
  }

  if (String(rec.receiver_id) !== String(userId)) {
    const err = new Error('Không tìm thấy lời mời kết bạn hoặc bạn không có quyền thực hiện');
    err.statusCode = 404;
    throw err;
  }

  if (rec.status !== 'pending') {
    const err = new Error(`Không thể từ chối lời mời có trạng thái: ${rec.status}`);
    err.statusCode = 400;
    throw err;
  }

  await ddbDocClient.send(new DeleteCommand({
    TableName: FRIENDS_TABLE,
    Key: { friendshipId: String(friendshipId) }
  }));

  return { id: friendshipId, status: 'rejected' };
}

async function getPendingRequests(userId) {
  const uid = String(userId);

  const res = await ddbDocClient.send(new ScanCommand({
    TableName: FRIENDS_TABLE,
    FilterExpression: 'receiver_id = :uid AND #st = :pending',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':uid': uid,
      ':pending': 'pending'
    }
  }));

  const items = (res.Items || []).sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const userService = require('./userService');
  const enriched = await Promise.all(
    items.map(async (item) => {
      const senderInfo = await userService.getUserById(item.sender_id);
      return {
        id: item.friendshipId,
        sender_id: item.sender_id,
        receiver_id: item.receiver_id,
        status: item.status,
        created_at: item.created_at,
        updated_at: item.updated_at,
        sender_display_name: senderInfo?.display_name || senderInfo?.displayName || '',
        sender_username: senderInfo?.username || '',
        sender_avatar_url: senderInfo?.avatar_url || senderInfo?.avatarUrl || null
      };
    })
  );

  return enriched;
}

async function getFriends(userId) {
  const uid = String(userId);

  const res = await ddbDocClient.send(new ScanCommand({
    TableName: FRIENDS_TABLE,
    FilterExpression: '(sender_id = :uid OR receiver_id = :uid) AND #st = :accepted',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':uid': uid,
      ':accepted': 'accepted'
    }
  }));

  const items = (res.Items || []).sort((a, b) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );

  const userService = require('./userService');
  const enriched = await Promise.all(
    items.map(async (item) => {
      const friendId = item.sender_id === uid ? item.receiver_id : item.sender_id;
      const friendInfo = await userService.getUserById(friendId);
      // Nickname & Background: mỗi hướng lưu riêng
      const isSender = item.sender_id === uid;
      const nickname = isSender ? (item.nickname_sender || null) : (item.nickname_receiver || null);
      const chatBgUrl = isSender ? (item.chatBgUrl_sender || null) : (item.chatBgUrl_receiver || null);
      const originalName = friendInfo?.display_name || friendInfo?.displayName || '';
      return {
        friendshipId: item.friendshipId,
        friend_id: friendId,
        status: item.status,
        updated_at: item.updated_at,
        friend_display_name: nickname || originalName,
        friend_original_name: originalName,
        friend_username: friendInfo?.username || '',
        friend_avatar_url: friendInfo?.avatar_url || friendInfo?.avatarUrl || null,
        nickname: nickname,
        chatBgUrl: chatBgUrl,
        pinnedMessages: item.pinnedMessages || []
      };
    })
  );

  return enriched;
}

/**
 * Cập nhật nickname cho bạn bè (lưu theo hướng: ai đặt thì lưu cho người đó)
 */
async function updateNickname(friendshipId, userId, nickname) {
  const rec = await getFriendshipByFriendshipId(friendshipId);
  if (!rec) {
    const err = new Error('Không tìm thấy quan hệ bạn bè');
    err.statusCode = 404;
    throw err;
  }

  const uid = String(userId);
  const isSender = rec.sender_id === uid;
  const field = isSender ? 'nickname_sender' : 'nickname_receiver';

  await ddbDocClient.send(new UpdateCommand({
    TableName: FRIENDS_TABLE,
    Key: { friendshipId: String(friendshipId) },
    UpdateExpression: `SET ${field} = :n, updated_at = :u`,
    ExpressionAttributeValues: {
      ':n': nickname || null,
      ':u': new Date().toISOString()
    }
  }));

  return { friendshipId, nickname: nickname || null };
}

/**
 * Lấy / cập nhật cài đặt chat (background) cho một conversation
 */
async function updateChatBackground(userId, friendshipId, bgUrl, bothSides = false) {
  const rec = await getFriendshipByFriendshipId(friendshipId);
  if (!rec) throw new Error('Không tìm thấy quan hệ bạn bè');

  const uid = String(userId);
  const isSender = String(rec.sender_id) === uid;
  
  let updateExpr = '';
  let attrValues = { ':bg': bgUrl || null, ':u': new Date().toISOString() };

  if (bothSides) {
    updateExpr = 'SET chatBgUrl_sender = :bg, chatBgUrl_receiver = :bg, updated_at = :u';
  } else {
    const field = isSender ? 'chatBgUrl_sender' : 'chatBgUrl_receiver';
    updateExpr = `SET ${field} = :bg, updated_at = :u`;
  }

  await ddbDocClient.send(new UpdateCommand({
    TableName: FRIENDS_TABLE,
    Key: { friendshipId: String(friendshipId) },
    UpdateExpression: updateExpr,
    ExpressionAttributeValues: attrValues
  }));

  return { friendshipId, chatBgUrl: bgUrl || null };
}

async function getChatBackground(userId, friendshipId) {
  const rec = await getFriendshipByFriendshipId(friendshipId);
  if (!rec) return null;
  const isSender = String(rec.sender_id) === String(userId);
  return isSender ? (rec.chatBgUrl_sender || null) : (rec.chatBgUrl_receiver || null);
}

async function pinMessage(friendshipId, message, pinnedBy) {
  const rec = await getFriendshipByFriendshipId(friendshipId);
  if (!rec) throw new Error('Không tìm thấy quan hệ bạn bè');

  let pinned = Array.isArray(rec.pinnedMessages) ? rec.pinnedMessages : [];
  // Tránh trùng lặp
  pinned = pinned.filter(m => String(m.id) !== String(message.id));
  
  const pinObj = {
    ...message,
    pinnedBy: String(pinnedBy),
    pinnedAt: new Date().toISOString()
  };
  pinned.unshift(pinObj); // Thêm vào đầu danh sách

  await ddbDocClient.send(new UpdateCommand({
    TableName: FRIENDS_TABLE,
    Key: { friendshipId: String(friendshipId) },
    UpdateExpression: 'SET pinnedMessages = :p, updated_at = :u',
    ExpressionAttributeValues: {
      ':p': pinned,
      ':u': new Date().toISOString()
    }
  }));
  return pinned;
}

async function unpinMessage(friendshipId, messageId, requestUserId) {
  const rec = await getFriendshipByFriendshipId(friendshipId);
  if (!rec) throw new Error('Không tìm thấy quan hệ bạn bè');

  let pinned = Array.isArray(rec.pinnedMessages) ? rec.pinnedMessages : [];
  
  // Kiểm tra quyền: Chỉ người ghim mới được gỡ (hoặc tin nhắn cũ chưa có pinnedBy)
  const pinToUnpin = pinned.find(m => String(m.id) === String(messageId));
  if (pinToUnpin && pinToUnpin.pinnedBy && String(pinToUnpin.pinnedBy) !== String(requestUserId)) {
    throw new Error('Bạn chỉ có thể gỡ tin nhắn do chính mình ghim');
  }

  pinned = pinned.filter(m => String(m.id) !== String(messageId));

  await ddbDocClient.send(new UpdateCommand({
    TableName: FRIENDS_TABLE,
    Key: { friendshipId: String(friendshipId) },
    UpdateExpression: 'SET pinnedMessages = :p, updated_at = :u',
    ExpressionAttributeValues: {
      ':p': pinned,
      ':u': new Date().toISOString()
    }
  }));
  return pinned;
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
  pinMessage,
  unpinMessage,
  findExistingRecord,
};
