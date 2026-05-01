const crypto = require("crypto");
const { saveCallLogMessage } = require("../messages/messageService");
const { emitToRoom, roomToConversation, roomStartedAt } = require("../../socket/socketHandler");



// Lấy Secret cấu hình trong .env
const ZEGO_SERVER_SECRET = process.env.ZEGO_SERVER_SECRET;

/**
 * Hàm kiểm tra chữ ký Webhook từ ZegoCloud
 * Thuật toán thường dùng: sha1(secret + timestamp + nonce)
 */
function verifySignature(signature, timestamp, nonce) {
  if (!signature || !timestamp || !nonce) return false;
  if (!ZEGO_SERVER_SECRET) {
    console.warn("[ZegoWebhook] Chưa cấu hình ZEGO_SERVER_SECRET trong .env");
    return true; // Bypass nếu chưa config (chỉ dùng cho dev)
  }

  try {
    const hash = crypto.createHash("sha1");
    // Theo chuẩn Zego: hash(secret + timestamp + nonce)
    hash.update(ZEGO_SERVER_SECRET + timestamp + nonce);
    const calculatedSignature = hash.digest("hex");
    
    return calculatedSignature === signature;
  } catch (error) {
    console.error("[ZegoWebhook] Lỗi xác thực signature:", error);
    return false;
  }
}

/**
 * Controller nhận Webhook từ ZegoCloud (Server-to-Server)
 * POST /api/calls/webhook/zegocloud
 */
async function handleZegoWebhook(req, res) {
  // ── 🔍 Log RAW payload để xem chính xác ZegoCloud gửi gì ───────────────
  console.log("🔍 [ZEGO RAW PAYLOAD]:", JSON.stringify(req.body, null, 2));
  console.log("📥 [ZegoWebhook] Headers:", JSON.stringify(req.headers, null, 2));

  try {
    // 1. Parse event
    const eventData = req.body;
    const eventType = eventData.event;

    console.log(`[ZegoWebhook] Event type: "${eventType}"`);

    // 2. Bảo mật: Check signature (tạm bypass cho dev)
    /* Nếu cần bật lại:
    const { signature, timestamp, nonce } = req.body;
    if (!verifySignature(signature, timestamp, nonce)) {
      console.warn("[ZegoWebhook] Signature không khớp");
      return res.status(200).json({ code: 403, message: "Invalid signature" });
    }
    */

    // 3. Chỉ xử lý event đóng phòng
    if (eventType === "room_close") {
      // ZegoCloud gửi room_id là roomId của Zego (ví dụ: call_1vs1_...)
      // Cần tra cứu conversationId thật (dm:...) từ map đã lưu khi call-request
      const zegoRoomId = String(eventData.room_id || "");
      const conversationId = roomToConversation.get(zegoRoomId) || zegoRoomId;

      console.log(`[ZegoWebhook] zegoRoomId="${zegoRoomId}" → conversationId="${conversationId}"`);

      if (!conversationId) {
        console.error("[ZegoWebhook] ❌ room_id bị thiếu trong payload, bỏ qua event này.");
        return res.status(200).json({ code: 0, message: "ok (skipped: no room_id)" });
      }

      // ── Tính duration — xử lý mọi format ZegoCloud có thể gửi ─────────
      //
      // ZegoCloud có thể dùng nhiều tên field khác nhau:
      //   - start_time / end_time     (ms hoặc s)
      //   - create_time / close_time  (ms hoặc s)
      //   - duration                  (ms hoặc s)
      //
      // Heuristic: nếu giá trị > 1e10 thì là milliseconds, ngược lại là seconds

      const toMs = (val) => {
        const n = Number(val);
        if (!n || isNaN(n)) return 0;
        return n > 1e10 ? n : n * 1000; // nếu < 1e10 thì đơn vị là giây, đổi sang ms
      };

      // Thử lấy thời điểm bắt đầu — ưu tiên start_time, fallback create_time
      const startMs = toMs(eventData.start_time) || toMs(eventData.create_time);
      // Thử lấy thời điểm kết thúc — ưu tiên end_time, fallback close_time
      const endMs   = toMs(eventData.end_time)   || toMs(eventData.close_time);

      console.log(`[ZegoWebhook] Timestamps: start_time=${eventData.start_time}, end_time=${eventData.end_time}, create_time=${eventData.create_time}, close_time=${eventData.close_time}`);
      console.log(`[ZegoWebhook] Computed: startMs=${startMs}, endMs=${endMs}`);

      let durationInSeconds = 0;

      if (startMs && endMs && endMs > startMs) {
        // Trường hợp 1: có đủ start và end → tính hiệu
        durationInSeconds = Math.round((endMs - startMs) / 1000);
        console.log(`[ZegoWebhook] Duration từ start/end: ${durationInSeconds}s`);
      } else if (eventData.duration != null) {
        // Trường hợp 2: ZegoCloud gửi sẵn field duration
        const rawDuration = Number(eventData.duration);
        durationInSeconds = rawDuration > 1e7
          ? Math.round(rawDuration / 1000)
          : Math.round(rawDuration);
        console.log(`[ZegoWebhook] Duration từ field duration: ${durationInSeconds}s (raw=${rawDuration})`);
      } else {
        // Trường hợp 3: fallback dùng roomStartedAt map (luôn chính xác)
        const localStartedAt = roomStartedAt.get(zegoRoomId);
        if (localStartedAt) {
          durationInSeconds = Math.round((Date.now() - localStartedAt) / 1000);
          console.log(`[ZegoWebhook] Duration từ roomStartedAt local map: ${durationInSeconds}s`);
          roomStartedAt.delete(zegoRoomId); // dọn bộ nhớ
        } else {
          console.warn("[ZegoWebhook] ⚠️ Không tìm thấy thông tin thời gian. Duration mặc định = 0.");
        }
      }

      // ── Xác định status dựa trên duration thực tế ─────────────────────
      // > 0s → cuộc gọi thực sự diễn ra (completed)
      // = 0s → vừa vào đã thoát hoặc không ai nhấc máy (missed)
      const status   = durationInSeconds > 0 ? "completed" : "missed";
      const callType = eventData.call_type || "video";

      // ── Trích xuất senderId — KHÔNG để undefined ───────────────────────
      const rawSenderId = eventData.creator_id || eventData.caller_id;
      const senderId    = rawSenderId && String(rawSenderId).trim()
        ? String(rawSenderId).trim()
        : "zego_webhook";

      console.log(`[ZegoWebhook] ✅ callType="${callType}", status="${status}", duration=${durationInSeconds}s, senderId="${senderId}"`);

      const callData = { callType, status, duration: durationInSeconds };

      // ── Lưu vào DynamoDB ───────────────────────────────────────────────
      let callLogItem = null;
      try {
        callLogItem = await saveCallLogMessage({ conversationId, senderId, callData });
        console.log(`✅ [ZegoWebhook] Lưu DB thành công: conversationId=${conversationId}, messageId=${callLogItem?.messageId}`);
      } catch (dbError) {
        console.error("❌ [ZegoWebhook] Lưu DB thất bại:", dbError.message, dbError.stack);
        return res.status(200).json({ code: 0, message: "ok (db write failed, check server logs)" });
      }

      // ── Emit socket SAU KHI lưu DB thành công ─────────────────────────
      try {
        emitToRoom(conversationId, "receive_message", callLogItem);
        console.log(`✅ [ZegoWebhook] Emit socket thành công → room "${conversationId}"`);

        // DM fallback: emit cả chiều đảo ngược dm:B:A
        if (conversationId.startsWith("dm:")) {
          const parts = conversationId.split(":");
          if (parts.length >= 3) {
            const reversed = `dm:${parts[2]}:${parts[1]}`;
            if (reversed !== conversationId) {
              emitToRoom(reversed, "receive_message", callLogItem);
              console.log(`✅ [ZegoWebhook] Emit fallback → room "${reversed}"`);
            }
          }
        }
      } catch (socketError) {
        console.error("⚠️ [ZegoWebhook] Emit socket thất bại:", socketError.message);
      }
    } else {
      console.log(`[ZegoWebhook] Bỏ qua event không xử lý: "${eventType}"`);
    }

    // ZegoCloud LUÔN cần nhận 200 OK để không retry
    return res.status(200).json({ code: 0, message: "success" });


  } catch (error) {
    console.error("❌ [ZegoWebhook] Lỗi không xử lý được:", error.message, error.stack);
    // Luôn trả 200 để ZegoCloud không spam retry
    return res.status(200).json({ code: 0, message: "ok (internal error, check logs)" });
  }
}

module.exports = {
  handleZegoWebhook,
  verifySignature
};
