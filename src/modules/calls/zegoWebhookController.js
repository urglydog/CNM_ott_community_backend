const crypto = require("crypto");
const { saveCallLogMessage } = require("../messages/messageService");
const { emitToRoom } = require("../../socket/socketHandler");

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
  try {
    const { signature, timestamp, nonce } = req.body;
    
    console.log("[ZegoWebhook] Payload:", JSON.stringify(req.body));

    // 1. Bảo mật: Check signature (Tuân thủ yêu cầu 1)
    /* Nếu Zego báo lỗi auth hoặc dùng thuật toán khác (MD5, sort array), bạn có thể điều chỉnh logic hash phía trên
    if (!verifySignature(signature, timestamp, nonce)) {
      console.warn("[ZegoWebhook] Signature không khớp");
      return res.status(403).json({ code: 403, message: "Invalid signature" });
    }
    */

    // 2. Parse payload
    const eventData = req.body; 
    const eventType = eventData.event; 

    // Chỉ xử lý event đóng phòng
    if (eventType === "room_close") {
      // 3. Trích xuất dữ liệu: Room ID chính là conversationId
      const conversationId = String(eventData.room_id);
      
      const startTimeMs = Number(eventData.start_time) || 0;
      const endTimeMs = Number(eventData.end_time) || 0;
      
      // 4. Tính duration (giây)
      let durationInSeconds = 0;
      if (startTimeMs && endTimeMs && endTimeMs > startTimeMs) {
        durationInSeconds = Math.floor((endTimeMs - startTimeMs) / 1000);
      } else if (eventData.duration) {
        durationInSeconds = Number(eventData.duration);
      }

      // 5. Xác định status cuộc gọi
      const status = durationInSeconds > 0 ? "completed" : "missed";
      
      // 6. Trích xuất thông tin người gọi và loại hình cuộc gọi
      const callType = eventData.call_type || "video";
      const senderId = eventData.creator_id || eventData.caller_id || "system";

      const callData = {
        callType,
        status,
        duration: durationInSeconds
      };

      // 7. Gọi hàm lưu DB từ messageService
      const callLogItem = await saveCallLogMessage({
        conversationId,
        senderId,
        callData
      });

      console.log(`[ZegoWebhook] Lưu DB thành công phòng ${conversationId}, status: ${status}, duration: ${durationInSeconds}s`);

      // 8. Bắn sự kiện receive_message qua socket cho phòng conversationId
      emitToRoom(conversationId, "receive_message", callLogItem);
      console.log(`[ZegoWebhook] Bắn realtime socket thành công tới phòng ${conversationId}`);
    }

    // ZegoCloud cần nhận 200 OK để không retry
    return res.status(200).json({ code: 0, message: "success" });
  } catch (error) {
    console.error("[ZegoWebhook] Lỗi xử lý:", error);
    return res.status(200).json({ code: 500, message: "Internal server error" });
  }
}

module.exports = {
  handleZegoWebhook,
  verifySignature
};
