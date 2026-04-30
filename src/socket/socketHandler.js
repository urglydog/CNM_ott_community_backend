const { ddbDocClient } = require("../config/awsConfig");
const {
  PutCommand,
  GetCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { saveMessage } = require("../modules/messages/messageService");
const { notifyMessageCreated } = require("../modules/notifications/notificationService");
const { verifyToken } = require("../common/utils/jwt");

const MEMBERS_TABLE = process.env.DDB_MEMBERS_TABLE || "ott_group_members";
const USERS_TABLE = process.env.DDB_USERS_TABLE || "ott_users";

// ============================================================
// CALL MANAGER (Server-authoritative)
// ============================================================
// roomId -> { callerId, receiverIds: string[], status, timeoutRef }
const activeCalls = new Map();

/**
 * Lấy displayName và avatarUrl của user từ bảng ott_users.
 * @param {string} userId
 * @returns {Promise<{displayName: string, avatarUrl: string|null}>}
 */
async function getUserDisplayInfo(userId) {
  try {
    const result = await ddbDocClient.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { userId: String(userId) },
      }),
    );
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
const {
  onlineUsers,
  registerSocket,
  unregisterSocket,
} = require("./socketUserRegistry");

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
  let targetGroupId = String(groupId);
  const targetUserId = String(userId);

  // --- DM conversation: "dm:userA:userB" ---
  // Cho phép join/send nếu user là 1 trong 2 participant
  if (targetGroupId.startsWith("dm:")) {
    const parts = targetGroupId.split(":");
    if (parts.length >= 3) {
      const participantA = parts[1];
      const participantB = parts[2];
      return targetUserId === participantA || targetUserId === participantB;
    }
    // malformed dm: treat as not a member
    console.warn(`[checkUserInGroup] Malformed DM roomId: ${targetGroupId}`);
    return false;
  }

  // Gọt bỏ chữ "channel:" nếu frontend lỡ gửi thừa
  if (targetGroupId.startsWith("channel:")) {
    targetGroupId = targetGroupId.replace("channel:", "");
  }

  // --- Group: Query bảng ott_group_members với composite key (groupId, userId) ---
  try {
    const result = await ddbDocClient.send(
      new QueryCommand({
        TableName: MEMBERS_TABLE,
        KeyConditionExpression: "groupId = :gid AND userId = :uid",
        ExpressionAttributeValues: {
          ":gid": targetGroupId,
          ":uid": targetUserId,
        },
        Limit: 1,
      }),
    );

    return !!(result.Items && result.Items.length > 0);
  } catch (error) {
    console.error(
      `[checkUserInGroup] DynamoDB error for group=${targetGroupId} user=${targetUserId}:`,
      error.message,
    );
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
    return next(new Error("Lỗi xác thực: vui lòng cung cấp token"));
  }

  try {
    const decoded = verifyToken(token);
    socket.user = decoded;
    next();
  } catch (err) {
    return next(new Error("Lỗi xác thực: token không hợp lệ hoặc đã hết hạn"));
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
  const userIdKey = userId != null ? String(userId) : "";

  // --- Đăng ký user vào danh sách online ---
  if (userIdKey) {
    registerSocket(userIdKey, socket.id);
    console.log(
      `[socket] User ${userIdKey} connected with socket ${socket.id}`,
    );

    // Auto join vào tất cả các group mà user đang tham gia để nhận thông báo realtime
    const { getGroupsForUser } = require("../modules/groups/groupService");
    getGroupsForUser(userIdKey)
      .then((groups) => {
        groups.forEach((g) => {
          socket.join(String(g.groupId));
        });
      })
      .catch((err) => {
        console.error(
          `[socket] Lỗi auto-join groups cho user ${userIdKey}:`,
          err.message,
        );
      });
  }

  const emitToUserSockets = (targetUserId, eventName, payload) => {
    const targetKey = String(targetUserId || "").trim();
    if (!targetKey) return false;

    const targetSockets = onlineUsers.get(targetKey);
    if (!targetSockets || targetSockets.size === 0) {
      console.warn(
        `[signal] No active socket found for user ${targetKey} (${eventName})`,
      );
      return false;
    }

    for (const targetSocketId of targetSockets) {
      io.to(targetSocketId).emit(eventName, payload);
    }

    console.log(
      `[signal] Forwarded ${eventName} to user ${targetKey} (${targetSockets.size} socket(s))`,
    );
    return true;
  };

  const clearActiveCall = (roomId) => {
    const record = activeCalls.get(roomId);
    if (record?.timeoutRef) {
      clearTimeout(record.timeoutRef);
    }
    activeCalls.delete(roomId);
  };

  const emitToCallParticipants = (record, eventName, payload) => {
    if (!record) return;
    const participants = [record.callerId, ...(record.receiverIds || [])];
    participants.forEach((id) => emitToUserSockets(id, eventName, payload));
  };

  const getCallsForUser = (targetUserId) => {
    const result = [];
    for (const [roomId, record] of activeCalls.entries()) {
      const inCall =
        String(record.callerId) === String(targetUserId) ||
        (record.receiverIds || []).some(
          (rid) => String(rid) === String(targetUserId),
        );
      if (inCall) result.push({ roomId, record });
    }
    return result;
  };

  // ============================================================
  // JOIN ROOM — có kiểm tra membership
  // ============================================================
  socket.on("join_room", async ({ roomId }, callback) => {
    if (!roomId) {
      _respond(callback, false, "Vui lòng cung cấp roomId");
      return;
    }

    if (!userId) {
      _respond(callback, false, "Người dùng chưa được xác thực");
      return;
    }

    // --- Kiểm tra membership trước khi cho join ---
    const isMember = await checkUserInGroup(roomId, userId);

    if (!isMember) {
      console.warn(
        `[join_room] User ${userId} denied: not a member of group ${roomId}`,
      );
      _respond(
        callback,
        false,
        "Từ chối truy cập: bạn không phải là thành viên của nhóm này",
      );
      return;
    }

    // --- Cho phép join ---
    socket.join(roomId);
    console.log(`[join_room] User ${userId} joined room ${roomId}`);

    // Thông báo cho client biết đã tham gia thành công
    socket.emit("room_joined", { roomId });

    // Thông báo cho các thành viên khác trong phòng
    socket.to(roomId).emit("user_joined", { userId, roomId });

    _respond(callback, true, null, { roomId });
  });

  // --- Tham gia phòng chat (legacy alias) ---
  // KHÔNG dùng socket.emit vì emit không truyền callback qua chain,
  // dẫn đến lỗi rơi vào "No callback provided" thay vì phản hồi client.
  // Inline thẳng logic kiểm tra membership.
  socket.on("join-group", async ({ groupId }, callback) => {
    if (!groupId) {
      _respond(callback, false, "groupId is required");
      return;
    }

    if (!userId) {
      _respond(callback, false, "User not authenticated");
      return;
    }

    const isMember = await checkUserInGroup(groupId, userId);

    if (!isMember) {
      console.warn(`[join-group] User ${userId} denied from group ${groupId}`);
      _respond(
        callback,
        false,
        "Access denied: you are not a member of this group",
      );
      return;
    }

    socket.join(groupId);
    console.log(`[join-group] User ${userId} joined group ${groupId}`);

    socket.emit("room_joined", { roomId: groupId });
    socket.to(groupId).emit("user_joined", { userId, roomId: groupId });

    _respond(callback, true, null, { roomId: groupId });
  });

  // ============================================================
  // LEAVE ROOM
  // ============================================================
  socket.on("leave_room", ({ roomId }) => {
    if (!roomId) return;
    socket.leave(roomId);
    socket.to(roomId).emit("user_left", { userId, roomId });
  });

  // ============================================================
  // SEND MESSAGE — có kiểm tra membership
  // ============================================================
  socket.on("send_message", async (payload, callback) => {
    // Payload: { roomId, content, contentType, attachments, stickerData }
    const contentType = payload.contentType || "text";

    // sticker: không bắt buộc content; emoji/sticker: dùng stickerData thay thế
    const hasContent = payload.content && String(payload.content).trim();
    const hasStickerData = contentType === "sticker" && payload.stickerData;
    const isEmoji = contentType === "emoji";

    if (!payload.roomId) {
      return _respond(callback, false, "roomId is required");
    }
    if (!hasContent && !hasStickerData && !isEmoji) {
      return _respond(callback, false, "content or stickerData is required");
    }

    if (!userId) {
      return _respond(callback, false, "User not authenticated");
    }

    // --- Kiểm tra membership trước khi lưu tin nhắn ---
    const isMember = await checkUserInGroup(payload.roomId, userId);

    if (!isMember) {
      console.warn(
        `[send_message] User ${userId} tried to send in non-member group ${payload.roomId}`,
      );
      return _respond(callback, false, "Not a member of this group");
    }

    try {
      // sticker: content có thể là undefined → service sẽ tự tạo từ stickerData
      // emoji: content luôn là emoji string
      const entityPayload = {
        conversationId: payload.roomId,
        senderId: userId,
        content: hasContent ? payload.content.trim() : payload.content,
        contentType,
        attachments: payload.attachments || null,
        ...(hasStickerData ? { stickerData: payload.stickerData } : {}),
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
      io.to(payload.roomId).emit("receive_message", enrichedMessage);

      // DM compatibility: một số client cũ có thể join room DM theo thứ tự id ngược lại.
      // Emit thêm sang room đảo chiều để tránh mất tin nhắn realtime (đặc biệt với luồng gửi video qua socket).
      if (payload.roomId.startsWith("dm:")) {
        const parts = payload.roomId.split(":");
        if (parts.length >= 3) {
          const reversedRoomId = `dm:${parts[2]}:${parts[1]}`;
          if (reversedRoomId !== payload.roomId) {
            io.to(reversedRoomId).emit("receive_message", enrichedMessage);
          }
        }
      }

      // Nếu là DM 1:1, gửi thêm đích danh trực tiếp tới socket người nhận
      // (phòng trường hợp người nhận chưa join room hoặc đang ở tab khác)
      if (payload.roomId.startsWith("dm:")) {
        const parts = payload.roomId.split(":");
        if (parts.length >= 3) {
          const receiverId = parts[1] === String(userId) ? parts[2] : parts[1];
          const receiverSockets = onlineUsers.get(String(receiverId));
          if (receiverSockets) {
            for (const sockId of receiverSockets) {
              const receiverSocket = io.sockets.sockets.get(sockId);
              const alreadyInRoom = receiverSocket?.rooms?.has(payload.roomId);

              // Socket đã ở trong phòng thì đã nhận từ io.to(roomId).emit phía trên.
              if (alreadyInRoom) continue;

              io.to(sockId).emit("receive_message", enrichedMessage);
            }
          }
        }
      }

      await notifyMessageCreated(enrichedMessage, io);

      _respond(callback, true, null, { message: enrichedMessage });
    } catch (error) {
      console.error("[send_message] saveMessage error:", error.message);
      _respond(callback, false, error.message);
    }
  });

  // --- Gửi tin nhắn (legacy alias cho backward compatibility) ---
  socket.on("send-message", async (payload, callback) => {
    socket.emit("send_message", payload, callback);
  });

  // ============================================================
  // TYPING INDICATOR — cũng nên kiểm tra membership
  // ============================================================
  socket.on("typing_start", async ({ roomId }, callback) => {
    if (!roomId) {
      _respond(callback, false, "roomId is required");
      return;
    }

    if (!userId) {
      _respond(callback, false, "User not authenticated");
      return;
    }

    const isMember = await checkUserInGroup(roomId, userId);
    if (!isMember) {
      _respond(callback, false, "Not a member of this group");
      return;
    }

    // Gửi cho tất cả người khác trong phòng (không gửi lại cho chính mình)
    socket.to(roomId).emit("user_typing", {
      roomId,
      userId,
      userName: socket.user?.username || "",
    });

    _respond(callback, true);
  });

  socket.on("typing_stop", async ({ roomId }, callback) => {
    if (!roomId) {
      _respond(callback, false, "roomId is required");
      return;
    }

    if (!userId) {
      _respond(callback, false, "User not authenticated");
      return;
    }

    const isMember = await checkUserInGroup(roomId, userId);
    if (!isMember) {
      _respond(callback, false, "Not a member of this group");
      return;
    }

    socket.to(roomId).emit("user_stopped_typing", {
      roomId,
      userId,
    });

    _respond(callback, true);
  });

  // ============================================================
  // CALL MANAGER EVENTS (Server-authoritative)
  // ============================================================
  socket.on("call-request", (data = {}, callback) => {
    const callerId = String(data.callerId || userIdKey || "").trim();
    const receiverId = String(data.receiverId || data.to || "").trim();
    const roomId = String(data.roomId || "").trim();

    if (!callerId || !receiverId || !roomId) {
      _respond(callback, false, "callerId, receiverId, roomId are required");
      return;
    }

    const record = {
      callerId,
      receiverIds: [receiverId],
      status: "ringing",
      timeoutRef: null,
    };

    // Override any existing call for this room
    clearActiveCall(roomId);
    activeCalls.set(roomId, record);

    record.timeoutRef = setTimeout(() => {
      const payload = {
        roomId,
        callerId,
        receiverId,
        reason: "timeout",
      };
      emitToCallParticipants(record, "call-timeout", payload);
      clearActiveCall(roomId);
    }, 30_000);

    const forwarded = emitToUserSockets(receiverId, "incoming-call", {
      ...data,
      callerId,
      receiverId,
      roomId,
    });

    if (!forwarded) {
      clearActiveCall(roomId);
      _respond(callback, false, "Receiver is offline");
      return;
    }

    _respond(callback, true);
  });

  socket.on("group-call-request", async (data = {}, callback) => {
    let { groupId, callerName } = data;
    const roomId = String(data.roomId || "").trim();

    if (!groupId) {
      _respond(callback, false, "groupId is required");
      return;
    }

    if (!userId) {
      _respond(callback, false, "User not authenticated");
      return;
    }

    if (String(groupId).startsWith("channel:")) {
      groupId = String(groupId).replace("channel:", "");
    }

    const isMember = await checkUserInGroup(groupId, userId);
    if (!isMember) {
      _respond(callback, false, "Not a member of this group");
      return;
    }

    if (!socket.rooms.has(String(groupId)) && !socket.rooms.has(`channel:${groupId}`)) {
      console.warn(
        `[Call Group] Caller ${userIdKey} has not joined room ${groupId}; reject signaling`,
      );
      _respond(callback, false, "Caller has not joined the group room");
      return;
    }

    const payload = {
      groupId: String(groupId),
      roomId: roomId,
      callerName: callerName || socket.user?.username || "",
      callerId: String(data.callerId || userIdKey),
      isGroupCall: true,
    };

    console.log(
      `[Call Group] Bao thuc phong: ${groupId} do ${payload.callerName || userId} goi`,
    );

    // Register call to activeCalls so handleCallAccept can find it
    const record = {
      callerId: payload.callerId,
      receiverIds: [String(groupId)], // For group, receiver is the group itself
      status: "ringing",
      timeoutRef: null,
      isGroupCall: true
    };
    clearActiveCall(roomId);
    activeCalls.set(roomId, record);
    
    record.timeoutRef = setTimeout(() => {
      emitToCallParticipants(record, "call-timeout", {
        roomId,
        callerId: payload.callerId,
        reason: "timeout",
      });
      // Also emit to the group room directly
      io.to(String(groupId)).emit("call-timeout", {
        roomId,
        callerId: payload.callerId,
        reason: "timeout",
      });
      clearActiveCall(roomId);
    }, 30_000);

    socket.to(String(groupId)).emit("group-call-request", payload);
    // Emit sang cả room channel:... để đảm bảo clients cũ đang ở đó cũng nhận được
    socket.to(`channel:${groupId}`).emit("group-call-request", payload);

    _respond(callback, true);
  });

  const handleCallAccept = (data = {}, callback) => {
    const roomId = String(data.roomId || "").trim();
    const callerId = String(data.callerId || "").trim();
    const receiverId = String(data.receiverId || "").trim();
    if (!roomId || !callerId) {
      _respond(callback, false, "roomId and callerId are required");
      return;
    }

    const record = activeCalls.get(roomId);
    if (!record) {
      _respond(callback, false, "Call not found or already ended");
      return;
    }

    if (record.timeoutRef) {
      clearTimeout(record.timeoutRef);
      record.timeoutRef = null;
    }

    record.status = "in_call";

    const payload = {
      ...data,
      roomId,
      callerId: record.callerId,
      receiverId: receiverId || (record.receiverIds || [])[0] || "",
    };

    emitToUserSockets(record.callerId, "call-accepted", payload);
    console.log(`[signal] Forwarded call-accepted to caller ${record.callerId}`);

    _respond(callback, true);
  };

  socket.on("call-accepted", handleCallAccept);
  socket.on("call-accept", handleCallAccept);

  socket.on("call-reject", (data = {}, callback) => {
    const roomId = String(data.roomId || "").trim();
    if (!roomId) {
      _respond(callback, false, "roomId is required");
      return;
    }

    const record = activeCalls.get(roomId);
    if (!record) {
      _respond(callback, false, "Call not found or already ended");
      return;
    }

    clearActiveCall(roomId);
    emitToCallParticipants(record, "call-ended", {
      ...data,
      roomId,
      reason: "rejected",
    });

    _respond(callback, true);
  });

  socket.on("call-cancel", (data = {}, callback) => {
    const roomId = String(data.roomId || "").trim();
    if (!roomId) {
      _respond(callback, false, "roomId is required");
      return;
    }

    const record = activeCalls.get(roomId);
    if (!record) {
      _respond(callback, false, "Call not found or already ended");
      return;
    }

    clearActiveCall(roomId);
    emitToCallParticipants(record, "call-ended", {
      ...data,
      roomId,
      reason: "canceled",
    });

    _respond(callback, true);
  });

  socket.on("end-call", (data = {}, callback) => {
    const roomId = String(data.roomId || "").trim();
    if (!roomId) {
      _respond(callback, false, "roomId is required");
      return;
    }

    const record = activeCalls.get(roomId);
    if (!record) {
      _respond(callback, false, "Call not found or already ended");
      return;
    }

    clearActiveCall(roomId);
    emitToCallParticipants(record, "call-ended", {
      ...data,
      roomId,
      reason: "ended",
    });

    _respond(callback, true);
  });

  // Backward compatibility for older event names
  socket.on("call-declined", (data = {}, callback) => {
    socket.emit("call-reject", data, callback);
  });

  socket.on("call-rejected", (data = {}, callback) => {
    socket.emit("call-reject", data, callback);
  });

  // ============================================================
  // NGẮT KẾT NỐI
  // ============================================================
  socket.on("disconnect", () => {
    if (userIdKey) {
      unregisterSocket(userIdKey, socket.id);
      console.log(
        `[socket] User ${userIdKey} disconnected socket ${socket.id}`,
      );
    }

    if (userIdKey) {
      const calls = getCallsForUser(userIdKey);
      calls.forEach(({ roomId, record }) => {
        clearActiveCall(roomId);
        emitToCallParticipants(record, "call-ended", {
          roomId,
          reason: "disconnect",
          disconnectedUserId: userIdKey,
        });
      });
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
  if (typeof callback === "function") {
    if (ok) {
      callback({ ok: true, ...extra });
    } else {
      callback({ ok: false, error: error || "Unknown error" });
    }
  } else if (!ok) {
    console.warn(
      `[signal] Callback missing for failed socket response: ${error || "Unknown error"}`,
    );
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
  checkUserInGroup,
  isUserOnline,
  notifyNewFriendRequest,
  notifyFriendAccepted,
};
