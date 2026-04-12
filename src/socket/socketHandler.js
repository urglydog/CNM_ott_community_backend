const { ddbDocClient } = require('../config/awsConfig');
const { PutCommand, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { saveMessage } = require('../modules/chat/messageService');
const { verifyToken } = require('../common/utils/jwt');

const MEMBERS_TABLE = process.env.DDB_MEMBERS_TABLE || 'ott_group_members';
const USERS_TABLE = process.env.DDB_USERS_TABLE || 'ott_users';

/**
 * Lấy displayName và avatarUrl của user từ bảng ott_users.
 * @param {string} userId
 * @returns {Promise<{displayName: string, avatarUrl: string|null}>}
 */
async function getUserDisplayInfo(userId) {
  try {
    const result = await ddbDocClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId: String(userId) }
    }));
    const u = result.Item;
    return {
      displayName: u?.display_name || u?.username || String(userId),
      avatarUrl: u?.avatar_url || null,
    };
  } catch {
    return { displayName: String(userId), avatarUrl: null };
  }
}

/**
 * In-memory map: userId (string) -> Set of socket.id
 * Mỗi user có thể mở nhiều tab/device → Set để lưu nhiều socket.id
 */
const onlineUsers = new Map();

let ioInstance = null;

/**
 * Khởi tạo io instance để dùng trong các hàm notification
 * @param {Server} io - Socket.io Server instance
 */
function initializeIO(io) {
  ioInstance = io;
}

/**
 * Lấy io instance (đã khởi tạo)
 */
function getIO() {
  return ioInstance;
}

/**
 * ============================================================
 * HELPER: Kiểm tra user có phải thành viên nhóm hay không
 * Bảng ott_group_members có composite key (groupId, userId)
 * ============================================================
 * @param {string} groupId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
/**
 * ============================================================
 * HELPER: Kiểm tra user có phải thành viên nhóm hay không
 * Bảng ott_group_members có composite key (groupId, userId)
 *
 * Xử lý 2 loại room:
 *  - Group:   roomId là groupId → Query bảng ott_group_members
 *  - DM:      roomId format "dm:userA:userB" → parse & verify user là 1 trong 2 participant
 * ============================================================
 * @param {string} groupId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function checkUserInGroup(groupId, userId) {
  const targetGroupId = String(groupId);
  const targetUserId = String(userId);

  // --- DM conversation: "dm:userA:userB" ---
  // Cho phép join/send nếu user là 1 trong 2 participant
  if (targetGroupId.startsWith('dm:')) {
    const parts = targetGroupId.split(':');
    if (parts.length >= 3) {
      const participantA = parts[1];
      const participantB = parts[2];
      return targetUserId === participantA || targetUserId === participantB;
    }
    // malformed dm: treat as not a member
    console.warn(`[checkUserInGroup] Malformed DM roomId: ${targetGroupId}`);
    return false;
  }

  // --- Group: Query bảng ott_group_members với composite key (groupId, userId) ---
  try {
    const result = await ddbDocClient.send(new QueryCommand({
      TableName: MEMBERS_TABLE,
      KeyConditionExpression: 'groupId = :gid AND userId = :uid',
      ExpressionAttributeValues: {
        ':gid': targetGroupId,
        ':uid': targetUserId
      },
      Limit: 1
    }));

    return !!(result.Items && result.Items.length > 0);
  } catch (error) {
    console.error(`[checkUserInGroup] DynamoDB error for group=${targetGroupId} user=${targetUserId}:`, error.message);
    return false;
  }
}

/**
 * Socket.io Authentication Middleware
 * Trích xuất JWT từ handshake auth, giải mã và gắn user vào socket.
 * Từ chối kết nối nếu token không hợp lệ hoặc không có token.
 */
function socketAuthMiddleware(socket, next) {
  const token = socket.handshake.auth?.token;

  if (!token) {
    return next(new Error('Authentication error: Token is required'));
  }

  try {
    const decoded = verifyToken(token);
    socket.user = decoded;
    next();
  } catch (err) {
    return next(new Error('Authentication error: Invalid or expired token'));
  }
}

/**
 * Xử lý kết nối Socket cho mỗi client đã được xác thực.
 * @param {Server} io - Socket.io Server instance
 * @param {Socket} socket - Socket instance
 */
function handleSocketConnection(io, socket) {
  // Client đã được gán user từ middleware xác thực ở trên
  const userId = socket.user?.id || socket.user?.userId;

  // --- Đăng ký user vào danh sách online ---
  if (userId) {
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);
  }

  // ============================================================
  // JOIN ROOM — có kiểm tra membership
  // ============================================================
  socket.on('join_room', async ({ roomId }, callback) => {
    if (!roomId) {
      _respond(callback, false, 'roomId is required');
      return;
    }

    if (!userId) {
      _respond(callback, false, 'User not authenticated');
      return;
    }

    // --- Kiểm tra membership trước khi cho join ---
    const isMember = await checkUserInGroup(roomId, userId);

    if (!isMember) {
      console.warn(`[join_room] User ${userId} denied: not a member of group ${roomId}`);
      _respond(callback, false, 'Access denied: you are not a member of this group');
      return;
    }

    // --- Cho phép join ---
    socket.join(roomId);
    console.log(`[join_room] User ${userId} joined room ${roomId}`);

    // Thông báo cho client biết đã tham gia thành công
    socket.emit('room_joined', { roomId });

    // Thông báo cho các thành viên khác trong phòng
    socket.to(roomId).emit('user_joined', { userId, roomId });

    _respond(callback, true, null, { roomId });
  });

  // --- Tham gia phòng chat (legacy alias) ---
  // KHÔNG dùng socket.emit vì emit không truyền callback qua chain,
  // dẫn đến lỗi rơi vào "No callback provided" thay vì phản hồi client.
  // Inline thẳng logic kiểm tra membership.
  socket.on('join-group', async ({ groupId }, callback) => {
    if (!groupId) {
      _respond(callback, false, 'groupId is required');
      return;
    }

    if (!userId) {
      _respond(callback, false, 'User not authenticated');
      return;
    }

    const isMember = await checkUserInGroup(groupId, userId);

    if (!isMember) {
      console.warn(`[join-group] User ${userId} denied from group ${groupId}`);
      _respond(callback, false, 'Access denied: you are not a member of this group');
      return;
    }

    socket.join(groupId);
    console.log(`[join-group] User ${userId} joined group ${groupId}`);

    socket.emit('room_joined', { roomId: groupId });
    socket.to(groupId).emit('user_joined', { userId, roomId: groupId });

    _respond(callback, true, null, { roomId: groupId });
  });

  // ============================================================
  // LEAVE ROOM
  // ============================================================
  socket.on('leave_room', ({ roomId }) => {
    if (!roomId) return;
    socket.leave(roomId);
    socket.to(roomId).emit('user_left', { userId, roomId });
  });

  // ============================================================
  // SEND MESSAGE — có kiểm tra membership
  // ============================================================
  socket.on('send_message', async (payload, callback) => {
    // Payload: { roomId, content, contentType, attachments }
    if (!payload.roomId || !payload.content?.trim()) {
      return _respond(callback, false, 'roomId and content are required');
    }

    if (!userId) {
      return _respond(callback, false, 'User not authenticated');
    }

    // --- Kiểm tra membership trước khi lưu tin nhắn ---
    const isMember = await checkUserInGroup(payload.roomId, userId);

    if (!isMember) {
      console.warn(`[send_message] User ${userId} tried to send in non-member group ${payload.roomId}`);
      return _respond(callback, false, 'Not a member of this group');
    }

    try {
      const entityPayload = {
        conversationId: payload.roomId,
        senderId: userId,
        content: payload.content.trim(),
        contentType: payload.contentType || 'text',
        attachments: payload.attachments || null
      };

      const savedMessage = await saveMessage(entityPayload);

      // Enrich với displayName/avatarUrl để frontend hiển thị đúng trong group chat
      const senderInfo = await getUserDisplayInfo(userId);
      const enrichedMessage = {
        ...savedMessage,
        senderDisplayName: senderInfo.displayName,
        senderAvatarUrl: senderInfo.avatarUrl,
      };

      // Broadcast tới tất cả thành viên trong phòng (bao gồm cả người gửi)
      io.to(payload.roomId).emit('receive_message', enrichedMessage);

      // Nếu là DM 1:1, gửi thêm đích danh trực tiếp tới socket người nhận
      // (phòng trường hợp người nhận chưa join room hoặc đang ở tab khác)
      if (payload.roomId.startsWith('dm:')) {
        const parts = payload.roomId.split(':');
        if (parts.length >= 3) {
          const receiverId = parts[1] === String(userId) ? parts[2] : parts[1];
          const receiverSockets = onlineUsers.get(String(receiverId));
          if (receiverSockets) {
            for (const sockId of receiverSockets) {
              io.to(sockId).emit('receive_message', enrichedMessage);
            }
          }
        }
      }

      _respond(callback, true, null, { message: enrichedMessage });
    } catch (error) {
      console.error('[send_message] saveMessage error:', error.message);
      _respond(callback, false, error.message);
    }
  });

  // --- Gửi tin nhắn (legacy alias cho backward compatibility) ---
  socket.on('send-message', async (payload, callback) => {
    socket.emit('send_message', payload, callback);
  });

  // ============================================================
  // TYPING INDICATOR — cũng nên kiểm tra membership
  // ============================================================
  socket.on('typing_start', async ({ roomId }, callback) => {
    if (!roomId) {
      _respond(callback, false, 'roomId is required');
      return;
    }

    if (!userId) {
      _respond(callback, false, 'User not authenticated');
      return;
    }

    const isMember = await checkUserInGroup(roomId, userId);
    if (!isMember) {
      _respond(callback, false, 'Not a member of this group');
      return;
    }

    // Gửi cho tất cả người khác trong phòng (không gửi lại cho chính mình)
    socket.to(roomId).emit('user_typing', {
      roomId,
      userId,
      userName: socket.user?.username || ''
    });

    _respond(callback, true);
  });

  socket.on('typing_stop', async ({ roomId }, callback) => {
    if (!roomId) {
      _respond(callback, false, 'roomId is required');
      return;
    }

    if (!userId) {
      _respond(callback, false, 'User not authenticated');
      return;
    }

    const isMember = await checkUserInGroup(roomId, userId);
    if (!isMember) {
      _respond(callback, false, 'Not a member of this group');
      return;
    }

    socket.to(roomId).emit('user_stopped_typing', {
      roomId,
      userId
    });

    _respond(callback, true);
  });

  // ============================================================
  // CALL RELATED EVENTS — nên kiểm tra membership
  // ============================================================
  socket.on('call-request', async ({ conversationId } = {}, callback) => {
    if (!conversationId) {
      _respond(callback, false, 'conversationId is required');
      return;
    }

    const isMember = await checkUserInGroup(conversationId, userId);
    if (!isMember) {
      _respond(callback, false, 'Not a member of this group');
      return;
    }

    socket.to(conversationId).emit('incoming-call', {
      from: { userId, username: socket.user?.username || '' }
    });

    _respond(callback, true);
  });

  socket.on('call-accepted', ({ conversationId } = {}) => {
    if (!conversationId) return;
    socket.to(conversationId).emit('call-accepted', {
      from: { userId, username: socket.user?.username || '' }
    });
  });

  socket.on('call-rejected', ({ conversationId } = {}) => {
    if (!conversationId) return;
    socket.to(conversationId).emit('call-rejected', {
      from: { userId, username: socket.user?.username || '' }
    });
  });

  socket.on('end-call', ({ conversationId } = {}) => {
    if (!conversationId) return;
    socket.to(conversationId).emit('end-call', {
      from: { userId, username: socket.user?.username || '' }
    });
  });

  // ============================================================
  // NGẮT KẾT NỐI
  // ============================================================
  socket.on('disconnect', () => {
    if (userId) {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
        }
      }
    }
  });
}

// ================================================================
// HÀM PHỤ TRỢ NỘI BỘ
// ================================================================

/**
 * Gửi phản hồi统一 qua callback hoặc emit event 'error'/'success'
 * @param {Function|undefined} callback
 * @param {boolean} ok
 * @param {string|null} error
 * @param {object} extra
 */
function _respond(callback, ok, error, extra = {}) {
  if (typeof callback === 'function') {
    if (ok) {
      callback({ ok: true, ...extra });
    } else {
      callback({ ok: false, error: error || 'Unknown error' });
    }
  } else if (!ok) {
    // Fallback: emit error event lên socket để client nhận được lỗi qua socket.on('error')
    socket?.emit('error', { code: 'MEMBERSHIP_DENIED', message: error || 'Access denied' });
  }
}

/**
 * Kiểm tra user có đang online hay không
 * @param {string} userId
 * @returns {boolean}
 */
function isUserOnline(userId) {
  const sockets = onlineUsers.get(String(userId));
  return sockets && sockets.size > 0;
}

/**
 * Gửi thông báo kết bạn mới đến người nhận
 * @param {string|number} receiverId - ID người nhận
 * @param {object} senderInfo - Thông tin người gửi { id, display_name, username, avatar_url }
 */
function notifyNewFriendRequest(receiverId, senderInfo) {
  const io = getIO();
  if (!io) return;

  const sockets = onlineUsers.get(String(receiverId));
  if (!sockets || sockets.size === 0) return;

  const payload = {
    type: 'new_friend_request',
    sender: {
      id: senderInfo.id,
      display_name: senderInfo.display_name,
      username: senderInfo.username,
      avatar_url: senderInfo.avatar_url
    },
    timestamp: new Date().toISOString()
  };

  for (const socketId of sockets) {
    io.to(socketId).emit('new_friend_request', payload);
  }
}

/**
 * Gửi thông báo lời mời kết bạn đã đ��ợc chấp nhận
 * @param {string|number} senderId - ID người gửi ban đầu
 * @param {object} receiverInfo - Thông tin người chấp nhận { id, display_name, username, avatar_url }
 */
function notifyFriendAccepted(senderId, receiverInfo) {
  const io = getIO();
  if (!io) return;

  const sockets = onlineUsers.get(String(senderId));
  if (!sockets || sockets.size === 0) return;

  const payload = {
    type: 'friend_request_accepted',
    receiver: {
      id: receiverInfo.id,
      display_name: receiverInfo.display_name,
      username: receiverInfo.username,
      avatar_url: receiverInfo.avatar_url
    },
    timestamp: new Date().toISOString()
  };

  for (const socketId of sockets) {
    io.to(socketId).emit('friend_request_accepted', payload);
  }
}

module.exports = {
  handleSocketConnection,
  socketAuthMiddleware,
  initializeIO,
  getIO,
  checkUserInGroup,
  isUserOnline,
  notifyNewFriendRequest,
  notifyFriendAccepted
};
