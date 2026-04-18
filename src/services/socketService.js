const { saveMessage } = require("./messageService");
const { verifyToken } = require("../utils/jwt");

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
 * Socket.io Authentication Middleware
 * Trích xuất JWT từ handshake auth, giải mã và gắn user vào socket.
 * Từ chối kết nối nếu token không hợp lệ hoặc không có token.
 */
function socketAuthMiddleware(socket, next) {
  const token = socket.handshake.auth?.token;

  if (!token) {
    return next(new Error("Authentication error: Token is required"));
  }

  try {
    const decoded = verifyToken(token);
    socket.user = decoded;
    next();
  } catch (err) {
    return next(new Error("Authentication error: Invalid or expired token"));
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

  // --- Tham gia phòng chat (room) ---
  socket.on("join_room", ({ roomId }) => {
    if (!roomId) return;

    socket.join(roomId);

    // Thông báo cho client biết đã tham gia thành công
    socket.emit("room_joined", { roomId });

    // Tùy chọn: thông báo cho các thành viên khác trong phòng
    socket.to(roomId).emit("user_joined", { userId, roomId });
  });

  socket.on("call-request", (payload = {}) => {
    const { conversationId } = payload;
    if (!conversationId) return;

    // In a 1-1 room, this forwards the incoming call signal to the other peer.
    socket.to(conversationId).emit("incoming-call", payload);
  });

  socket.on("call-accepted", (payload = {}) => {
    const { conversationId } = payload;
    if (!conversationId) return;

    socket.to(conversationId).emit("call-accepted", payload);
  });

  socket.on("call-rejected", (payload = {}) => {
    const { conversationId } = payload;
    if (!conversationId) return;

    socket.to(conversationId).emit("call-rejected", payload);
  });

  socket.on("end-call", (payload = {}) => {
    const { conversationId } = payload;
    if (!conversationId) return;

    socket.to(conversationId).emit("end-call", payload);
  });

  // --- Rời phòng chat ---
  socket.on("leave_room", ({ roomId }) => {
    if (!roomId) return;

    socket.leave(roomId);
    socket.to(roomId).emit("user_left", { userId, roomId });
  });

  // --- Gửi tin nhắn (Boundary: nhận payload từ client, trích sender_id từ auth) ---
  socket.on("send_message", async (payload, callback) => {
    // Payload: { roomId, content, contentType, attachments }
    // Frontend đã lo việc generate roomId chuẩn (dm:minId:maxId)
    if (!payload.roomId || !payload.content?.trim()) {
      return callback({ ok: false, error: "roomId and content are required" });
    }
    try {
      const entityPayload = {
        conversationId: payload.roomId,
        senderId: userId,
        content: payload.content.trim(),
        contentType: payload.contentType || "text",
        attachments: payload.attachments || null,
      };

      const savedMessage = await saveMessage(entityPayload);

      // Broadcast tin nhắn tới tất cả thành viên trong phòng (bao gồm cả người nhận)
      io.to(payload.roomId).emit("receive_message", savedMessage);

      // Phản hồi client: thông báo tin nhắn đã lưu và trạng thái "Đã gửi"
      callback({ ok: true, message: savedMessage });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  // --- Gửi tin nhắn (legacy alias cho backward compatibility) ---
  socket.on("send-message", async (payload, callback) => {
    socket.emit("send_message", payload, callback);
  });

  // --- Typing indicator ---
  socket.on("typing_start", ({ roomId }) => {
    if (!roomId) return;
    // Gửi cho tất cả người khác trong phòng (không gửi lại cho chính mình)
    socket.to(roomId).emit("user_typing", {
      roomId,
      userId,
      userName: socket.user?.username || "",
    });
  });

  socket.on("typing_stop", ({ roomId }) => {
    if (!roomId) return;
    socket.to(roomId).emit("user_stopped_typing", {
      roomId,
      userId,
    });
  });

  // --- Ngắt kết nối ---
  socket.on("disconnect", () => {
    // --- Xóa user khỏi danh sách online ---
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
    type: "new_friend_request",
    sender: {
      id: senderInfo.id,
      display_name: senderInfo.display_name,
      username: senderInfo.username,
      avatar_url: senderInfo.avatar_url,
    },
    timestamp: new Date().toISOString(),
  };

  for (const socketId of sockets) {
    io.to(socketId).emit("new_friend_request", payload);
  }
}

/**
 * Gửi thông báo lời mời kết bạn đã được chấp nhận
 * @param {string|number} senderId - ID người gửi ban đầu
 * @param {object} receiverInfo - Thông tin người chấp nhận { id, display_name, username, avatar_url }
 */
function notifyFriendAccepted(senderId, receiverInfo) {
  const io = getIO();
  if (!io) return;

  const sockets = onlineUsers.get(String(senderId));
  if (!sockets || sockets.size === 0) return;

  const payload = {
    type: "friend_request_accepted",
    receiver: {
      id: receiverInfo.id,
      display_name: receiverInfo.display_name,
      username: receiverInfo.username,
      avatar_url: receiverInfo.avatar_url,
    },
    timestamp: new Date().toISOString(),
  };

  for (const socketId of sockets) {
    io.to(socketId).emit("friend_request_accepted", payload);
  }
}

module.exports = {
  handleSocketConnection,
  socketAuthMiddleware,
  initializeIO,
  getIO,
  isUserOnline,
  notifyNewFriendRequest,
  notifyFriendAccepted,
};
