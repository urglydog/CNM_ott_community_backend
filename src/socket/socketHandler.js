const { ddbDocClient } = require("../config/awsConfig");
const {
  PutCommand,
  GetCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { saveMessage, saveCallLogMessage } = require("../modules/messages/messageService");
const { saveReadReceipt, getUserLastReadMessage } = require("../modules/messages/readReceiptService");
const { notifyMessageCreated } = require("../modules/notifications/notificationService");
const { verifyToken } = require("../common/utils/jwt");

const MEMBERS_TABLE = process.env.DDB_MEMBERS_TABLE || "ott_group_members";
const USERS_TABLE = process.env.DDB_USERS_TABLE || "ott_users";

// ============================================================
// READ RECEIPT DEDUPLICATION CACHE
// Prevents duplicate mark_read events from the same user for the same message
// ============================================================
const readReceiptDedupeCache = new Map(); // key: `${conversationId}:${messageId}:${userId}`, value: timestamp
const DEDUPE_WINDOW_MS = 2000; // 2 second window

function isDuplicateReadReceipt(conversationId, messageId, userId) {
  const key = `${conversationId}:${messageId}:${userId}`;
  const now = Date.now();
  const lastTime = readReceiptDedupeCache.get(key);

  if (lastTime && now - lastTime < DEDUPE_WINDOW_MS) {
    console.log(`[mark_read] DEDUP: Ignoring duplicate mark_read from ${userId} for ${messageId} (${now - lastTime}ms since last)`);
    return true;
  }

  readReceiptDedupeCache.set(key, now);

  // Cleanup old entries periodically
  if (readReceiptDedupeCache.size > 10000) {
    const cutoff = now - DEDUPE_WINDOW_MS * 2;
    for (const [k, v] of readReceiptDedupeCache) {
      if (v < cutoff) readReceiptDedupeCache.delete(k);
    }
  }

  return false;
}

// ============================================================
// CALL MANAGER (Server-authoritative)
// ============================================================
// roomId -> { callerId, receiverIds: string[], status, timeoutRef }
const activeCalls = new Map();

// Map ZegoCloud roomId (call_1vs1_...) -> conversationId (dm:...)
// Được ghi khi call-request, dùng bởi Webhook để trầ cứu conversationId đúng
const roomToConversation = new Map();

// Map ZegoCloud roomId -> startedAt (ms) — dùng để tính duration khi Zego webhook không gửi timestamp
const roomStartedAt = new Map();

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

  // --- Ghim tin nhắn ---
  socket.on("pin_message", async (data, callback) => {
    try {
      const { roomId, message } = data;
      const groupService = require("../modules/groups/groupService");
      const friendService = require("../modules/users/friendService");

      let pinnedList = [];
      if (roomId.startsWith("group_")) {
        pinnedList = await groupService.pinMessage(roomId, message, userIdKey);
      } else if (roomId.startsWith("dm:")) {
        const parts = roomId.split(":");
        const rec = await friendService.findExistingRecord(parts[1], parts[2]);
        if (!rec) throw new Error("Không tìm thấy thông tin bạn bè");
        pinnedList = await friendService.pinMessage(rec.friendshipId, message, userIdKey);
      }

      io.to(roomId).emit("message_pinned_updated", { roomId, pinnedMessages: pinnedList });
      _respond(callback, true, null, { pinnedMessages: pinnedList });
    } catch (error) {
      _respond(callback, false, error.message);
    }
  });

  socket.on("unpin_message", async (data, callback) => {
    try {
      const { roomId, messageId } = data;
      const groupService = require("../modules/groups/groupService");
      const friendService = require("../modules/users/friendService");

      let pinnedList = [];
      if (roomId.startsWith("group_")) {
        pinnedList = await groupService.unpinMessage(roomId, messageId, userIdKey);
      } else if (roomId.startsWith("dm:")) {
        const parts = roomId.split(":");
        const rec = await friendService.findExistingRecord(parts[1], parts[2]);
        if (!rec) throw new Error("Không tìm thấy thông tin bạn bè");
        pinnedList = await friendService.unpinMessage(rec.friendshipId, messageId, userIdKey);
      }

      io.to(roomId).emit("message_pinned_updated", { roomId, pinnedMessages: pinnedList });
      _respond(callback, true, null, { pinnedMessages: pinnedList });
    } catch (error) {
      _respond(callback, false, error.message);
    }
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
    // Payload: { roomId, content, contentType, attachments, stickerData, replyTo }
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
        // Thêm replyTo nếu có - ID của tin nhắn đang được trả lời
        ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
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
      userName: socket.user?.username || "",
    });

    _respond(callback, true);
  });

  // ============================================================
  // CHAT BACKGROUND UPDATE — Real-time sync
  // ============================================================
  socket.on("chat_background_updated", async (data, callback) => {
    try {
      const { friendshipId, bgUrl, receiverId } = data;
      if (!friendshipId) return _respond(callback, false, "friendshipId is required");

      // Gửi cho receiver qua các socket của họ
      if (receiverId) {
        emitToUserSockets(receiverId, "chat_background_updated", { 
          friendshipId, 
          bgUrl,
          updatedBy: userIdKey 
        });
      }

      _respond(callback, true);
    } catch (error) {
      console.error("[chat_background_updated] error:", error.message);
      _respond(callback, false, error.message);
    }
  // TYPING STOP ALL — gửi stop typing cho tất cả conversations khi logout
  // ============================================================
  socket.on("typing_stop_all", async ({ conversations = [] }, callback) => {
    if (!userId) {
      _respond(callback, false, "User not authenticated");
      return;
    }

    const userName = socket.user?.username || "";
    // Gửi user_stopped_typing cho tất cả conversations được cung cấp
    const rooms = Array.isArray(conversations) ? conversations : [];
    rooms.forEach((roomId) => {
      if (!roomId || typeof roomId !== "string") return;
      socket.to(roomId).emit("user_stopped_typing", {
        roomId,
        userId,
        userName,
      });
    });

    console.log(`[typing] User ${userId} sent stopped_typing to ${rooms.length} rooms`);
    _respond(callback, true, null, { count: rooms.length });
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
      conversationId: String(data.conversationId || ""), // lưu conversationId thật (dm:...) để dùng khi lưu call log
      status: "ringing",
      startedAt: null, // sẽ được set khi call-accepted
      timeoutRef: null,
    };

    // Override any existing call for this room
    clearActiveCall(roomId);
    activeCalls.set(roomId, record);

    // Lưu mapping roomId (Zego) → conversationId (dm:...) để Webhook tra cứu
    if (data.conversationId) {
      roomToConversation.set(roomId, String(data.conversationId));
      roomStartedAt.set(roomId, Date.now()); // ← lưu thời điểm bắt đầu
      console.log(`[call-request] Mapped roomId=${roomId} → conversationId=${data.conversationId}`);
    }

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
      conversationId: String(data.conversationId || groupId), // lưu conversationId thật (group_...) để dùng khi lưu call log
      status: "ringing",
      startedAt: Date.now(),  // ← set ngay khi tạo phòng để tính duration đúng
      timeoutRef: null,
      isGroupCall: true
    };
    clearActiveCall(roomId);
    activeCalls.set(roomId, record);

    // Lưu mapping roomId (Zego: group_call_...) → conversationId thật (group_...)
    const resolvedConvId = String(data.conversationId || groupId);
    if (resolvedConvId) {
      roomToConversation.set(roomId, resolvedConvId);
      roomStartedAt.set(roomId, Date.now()); // ← lưu thời điểm bắt đầu
      console.log(`[group-call-request] Mapped roomId=${roomId} → conversationId=${resolvedConvId}`);
    }

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

    // ── Lưu tin nhắn hệ thống "group_call_started" để hiển thị banner [Tham gia] ──
    try {
      const callerInfo = await (async () => {
        try {
          const res = await ddbDocClient.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId: String(payload.callerId) } }));
          return { displayName: res.Item?.displayName || res.Item?.username || "Ai đó", avatarUrl: res.Item?.avatarUrl || null };
        } catch { return { displayName: "Ai đó", avatarUrl: null }; }
      })();

      const startMsg = await saveCallLogMessage({
        conversationId: resolvedConvId,
        senderId: String(payload.callerId),
        callData: {
          callType: "video",
          status: "started",       // trạng thái đặc biệt — đang diễn ra
          duration: 0,
          roomId,                  // để nút [Tham gia] biết join vào phòng nào
          messageType: "group_call_started",
        },
      });

      // Override messageType để frontend phân biệt với call_log thông thường
      const enrichedStartMsg = {
        ...startMsg,
        messageType: "group_call_started",
        contentType: "group_call_started",
        content: `📞 ${callerInfo.displayName} đang gọi nhóm`,
        senderDisplayName: callerInfo.displayName,
        senderAvatarUrl: callerInfo.avatarUrl,
      };

      io.to(resolvedConvId).emit("receive_message", enrichedStartMsg);
      console.log(`[group-call-request] Đã gửi banner group_call_started → room ${resolvedConvId}`);
    } catch (err) {
      console.error("[group-call-request] Không thể lưu group_call_started:", err.message);
    }

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
    record.startedAt = Date.now(); // ⏱️ Ghi nhận mốc bắt đầu để tính duration chính xác

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

  // ============================================================
  // HELPER: Lưu call log vào DynamoDB và phát realtime
  // Được gọi sau khi một cuộc gọi kết thúc (end, reject, cancel, timeout)
  // ============================================================
  const saveCallLog = async ({ conversationId, callerId, callType, status, durationSec = 0 }) => {
    try {
      console.log(`📞 [saveCallLog] Bắt đầu lưu: conversationId=${conversationId}, callerId=${callerId}, status=${status}, duration=${durationSec}s`);
      const callLogItem = await saveCallLogMessage({
        conversationId: String(conversationId),
        senderId: String(callerId || "system"),
        callData: {
          callType: callType || "video",
          status,
          duration: Number(durationSec) || 0,
        },
      });
      console.log(`✅ [saveCallLog] Đã lưu call log: messageId=${callLogItem?.messageId}`);

      // Phát realtime tới tất cả người trong phòng
      io.to(conversationId).emit("receive_message", callLogItem);

      // DM fallback: emit số đảo room id
      if (conversationId.startsWith("dm:")) {
        const parts = conversationId.split(":");
        if (parts.length >= 3) {
          const reversedRoomId = `dm:${parts[2]}:${parts[1]}`;
          if (reversedRoomId !== conversationId) {
            io.to(reversedRoomId).emit("receive_message", callLogItem);
          }
        }
      }
    } catch (err) {
      console.error(`❌ [saveCallLog] Thất bại lưu call log:`, err.message, err.stack);
    }
  };

  socket.on("call-reject", async (data = {}, callback) => {
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

    // ── Lưu Call Log (missed) vào DynamoDB ────────────────────────────────
    // dùng data.conversationId (dm:...) — KHÔNG dùng roomId (call_1vs1_...)
    const rejectConversationId = String(data.conversationId || record.conversationId || "");
    if (!rejectConversationId) {
      console.error(`❌ [call-reject] Thiếu conversationId, không thể lưu call log. data.conversationId=${data.conversationId}`);
    } else {
      await saveCallLog({
        conversationId: rejectConversationId,
        callerId: record.callerId,
        callType: data.callType || "video",
        status: "missed",
        durationSec: 0,
      });
    }

    _respond(callback, true);
  });

  socket.on("call-cancel", async (data = {}, callback) => {
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

    // ── Lưu Call Log (canceled/missed) vào DynamoDB ───────────────────────
    // dùng data.conversationId (dm:...) — KHÔNG dùng roomId (call_1vs1_...)
    const cancelConversationId = String(data.conversationId || record.conversationId || "");
    if (!cancelConversationId) {
      console.error(`❌ [call-cancel] Thiếu conversationId, không thể lưu call log. data.conversationId=${data.conversationId}`);
    } else {
      await saveCallLog({
        conversationId: cancelConversationId,
        callerId: record.callerId,
        callType: data.callType || "video",
        status: "missed",
        durationSec: 0,
      });
    }

    _respond(callback, true);
  });

  socket.on("end-call", async (data = {}, callback) => {
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

    // Tính duration từ thời điểm bắt đầu (nếu record có startedAt)
    const durationSec = record.startedAt
      ? Math.floor((Date.now() - record.startedAt) / 1000)
      : (Number(data.duration) || 0);

    clearActiveCall(roomId);
    emitToCallParticipants(record, "call-ended", {
      ...data,
      roomId,
      reason: "ended",
    });

    // ── Lưu Call Log vào DynamoDB ──────────────────────────────────────────
    // dùng data.conversationId (dm:...) — KHÔNG dùng roomId (call_1vs1_...)
    const endConversationId = String(data.conversationId || record.conversationId || "");
    if (!endConversationId) {
      console.error(`❌ [end-call] Thiếu conversationId, không thể lưu call log. data.conversationId=${data.conversationId}`);
    } else {
      await saveCallLog({
        conversationId: endConversationId,
        callerId: record.callerId || userIdKey,
        callType: data.callType || "video",
        status: "completed",
        durationSec,
      });
    }

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
  // LIVE LOCATION — Chia sẻ vị trí trực tiếp (realtime)
  // KHÔNG lưu vào DB để tránh quá tải; chỉ broadcast trong room.
  //
  // Events:
  //   start_live_location  { roomId }          → báo bắt đầu chia sẻ
  //   update_live_location { roomId, lat, lng } → cập nhật tọa độ liên tục
  //   stop_live_location   { roomId }          → dừng chia sẻ
  // ============================================================

  socket.on("start_live_location", async ({ roomId }, callback) => {
    if (!roomId) {
      _respond(callback, false, "roomId is required");
      return;
    }
    if (!userId) {
      _respond(callback, false, "User not authenticated");
      return;
    }

    // Kiểm tra membership trước khi cho phép chia sẻ
    const isMember = await checkUserInGroup(roomId, userId);
    if (!isMember) {
      _respond(callback, false, "Not a member of this room");
      return;
    }

    const senderInfo = await getUserDisplayInfo(userId);

    // Thông báo cho các thành viên khác biết có người bắt đầu chia sẻ live location
    socket.to(roomId).emit("live_location_started", {
      roomId,
      senderId: userId,
      senderDisplayName: senderInfo.displayName,
      senderAvatarUrl: senderInfo.avatarUrl,
      startedAt: new Date().toISOString(),
    });

    console.log(`[live_location] User ${userId} started sharing in room ${roomId}`);
    _respond(callback, true);
  });

  socket.on("update_live_location", async ({ roomId, lat, lng }, callback) => {
    if (!roomId) {
      _respond(callback, false, "roomId is required");
      return;
    }
    if (typeof lat !== "number" || typeof lng !== "number") {
      _respond(callback, false, "lat và lng (number) là bắt buộc");
      return;
    }
    if (!userId) {
      _respond(callback, false, "User not authenticated");
      return;
    }

    // Broadcast tọa độ mới đến tất cả thành viên khác trong phòng
    // Không gửi lại cho người gửi (socket.to thay vì io.to)
    socket.to(roomId).emit("live_location_updated", {
      roomId,
      senderId: userId,
      lat,
      lng,
      updatedAt: new Date().toISOString(),
    });

    // Không cần callback trong trường hợp này vì event xảy ra rất thường xuyên
    _respond(callback, true);
  });

  socket.on("stop_live_location", async ({ roomId }, callback) => {
    if (!roomId) {
      _respond(callback, false, "roomId is required");
      return;
    }
    if (!userId) {
      _respond(callback, false, "User not authenticated");
      return;
    }

    // Thông báo cho các thành viên khác biết người dùng đã dừng chia sẻ
    socket.to(roomId).emit("live_location_stopped", {
      roomId,
      senderId: userId,
      stoppedAt: new Date().toISOString(),
    });

    console.log(`[live_location] User ${userId} stopped sharing in room ${roomId}`);
    _respond(callback, true);
  });

  // ============================================================
  // MARK READ — đánh dấu tin nhắn đã đọc (Read Receipts)
  // ============================================================
  socket.on("mark_read", async ({ conversationId, messageId }, callback) => {
    if (!conversationId) {
      return _respond(callback, false, "conversationId is required");
    }
    if (!messageId) {
      return _respond(callback, false, "messageId is required");
    }
    if (!userId) {
      return _respond(callback, false, "User not authenticated");
    }

    // Server-side deduplication check
    if (isDuplicateReadReceipt(conversationId, messageId, userId)) {
      return _respond(callback, true); // Still respond OK but don't process
    }

    try {
      // Verify membership
      const isMember = await checkUserInGroup(conversationId, userId);
      if (!isMember) {
        return _respond(callback, false, "Not a member of this conversation");
      }

      // Get user display info for the reader
      const readerInfo = await getUserDisplayInfo(userId);

      // Save the read receipt
      await saveReadReceipt({
        conversationId,
        messageId: String(messageId),
        userId: String(userId),
        readerName: readerInfo.displayName,
        readerAvatar: readerInfo.avatarUrl,
      });

      console.log(`[mark_read] User ${userId} marked message ${messageId} as read in conversation ${conversationId}`);

      // Determine the sender of the message to notify them
      // For DM conversations, notify the other participant
      if (conversationId.startsWith("dm:")) {
        const parts = conversationId.split(":");
        if (parts.length >= 3) {
          const senderId = parts[1] === String(userId) ? parts[2] : parts[1];
          // Emit to the sender's sockets
          const readReceiptPayload = {
            conversationId,
            messageId: String(messageId),
            readerId: String(userId),
            readerName: readerInfo.displayName,
            readerAvatar: readerInfo.avatarUrl,
            readAt: new Date().toISOString(),
          };

          // Emit directly to the sender's sockets
          emitToUserSockets(senderId, "message_read", readReceiptPayload);
          console.log(`[mark_read] Notified sender ${senderId} that message ${messageId} was read`);
        }
      } else {
        // For group chats, emit to the room so the sender can see who read their message
        // The sender will receive this if they're in the room
        socket.to(conversationId).emit("message_read", {
          conversationId,
          messageId: String(messageId),
          readerId: String(userId),
          readerName: readerInfo.displayName,
          readerAvatar: readerInfo.avatarUrl,
          readAt: new Date().toISOString(),
        });
      }

      _respond(callback, true);
    } catch (error) {
      console.error("[mark_read] Error:", error.message);
      _respond(callback, false, error.message);
    }
  });

  // ============================================================
  // NGẮT KẾT NỐI
  // ============================================================
  socket.on("disconnect", () => {
    if (userIdKey) {
      // Gửi user_stopped_typing cho tất cả các room mà user đang tham gia
      // để người nhận không còn thấy "đang soạn tin" khi user offline
      const rooms = Array.from(socket.rooms || []);
      const userName = socket.user?.username || "";
      rooms.forEach((roomId) => {
        // Bỏ qua socket ID của chính socket này (không phải conversation room)
        if (roomId === socket.id) return;
        // Bỏ qua các room hệ thống (nếu có prefix đặc biệt)
        if (roomId.startsWith("_")) return;

        io.to(roomId).emit("user_stopped_typing", {
          roomId,
          userId,
          userName,
        });
        console.log(`[typing] User ${userIdKey} disconnected - sent stopped_typing to room ${roomId}`);
      });

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

/**
 * Join một user vào socket room
 */
function joinUserToRoom(userId, roomId) {
  const io = getIO();
  if (!io) return;
  const sockets = onlineUsers.get(String(userId));
  if (sockets && sockets.size > 0) {
    for (const socketId of sockets) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.join(roomId);
    }
  }
}

/**
 * Kick một user ra khỏi socket room
 */
function leaveUserFromRoom(userId, roomId) {
  const io = getIO();
  if (!io) return;
  const sockets = onlineUsers.get(String(userId));
  if (sockets && sockets.size > 0) {
    for (const socketId of sockets) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.leave(roomId);
    }
  }
}

/**
 * Emit sự kiện tới một room cụ thể
 */
function emitToRoom(roomId, event, payload) {
  const io = getIO();
  if (!io) return;
  io.to(roomId).emit(event, payload);
}

/**
 * Emit event call_log tới room cụ thể
 */
function emitCallLogToRoom(io, conversationId, callLogData) {
  if (!io) return;
  io.to(String(conversationId)).emit("receive_message", callLogData);
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
  joinUserToRoom,
  leaveUserFromRoom,
  emitToRoom,
  roomToConversation,
  roomStartedAt,
};
