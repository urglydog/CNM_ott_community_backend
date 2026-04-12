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
    const err = new Error('Cannot send friend request to yourself');
    err.statusCode = 400;
    throw err;
  }

  // Kiểm tra bản ghi đã tồn tại (theo cả 2 chiều)
  const existing = await findExistingRecord(sender, receiver);

  if (existing) {
    if (existing.status === 'accepted') {
      const err = new Error('You are already friends');
      err.statusCode = 409;
      throw err;
    }
    if (existing.status === 'pending') {
      const err = new Error('Friend request already exists');
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
    const err = new Error('Friend request not found or you are not authorized');
    err.statusCode = 404;
    throw err;
  }

  if (String(rec.receiver_id) !== String(userId)) {
    const err = new Error('Friend request not found or you are not authorized');
    err.statusCode = 404;
    throw err;
  }

  if (rec.status !== 'pending') {
    const err = new Error(`Cannot accept a request with status: ${rec.status}`);
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
    const err = new Error('Friend request not found or you are not authorized');
    err.statusCode = 404;
    throw err;
  }

  if (String(rec.receiver_id) !== String(userId)) {
    const err = new Error('Friend request not found or you are not authorized');
    err.statusCode = 404;
    throw err;
  }

  if (rec.status !== 'pending') {
    const err = new Error(`Cannot reject a request with status: ${rec.status}`);
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
      return {
        friendshipId: item.friendshipId,
        friend_id: friendId,
        status: item.status,
        updated_at: item.updated_at,
        friend_display_name: friendInfo?.display_name || friendInfo?.displayName || '',
        friend_username: friendInfo?.username || '',
        friend_avatar_url: friendInfo?.avatar_url || friendInfo?.avatarUrl || null
      };
    })
  );

  return enriched;
}

module.exports = {
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  getPendingRequests,
  getFriends
};
