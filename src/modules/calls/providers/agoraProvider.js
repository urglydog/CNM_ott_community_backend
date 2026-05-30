/**
 * Agora RTC provider implementation.
 *
 * Generates tokens using the agora-access-token SDK.
 * UID generation is deterministic (MD5 hash of userId → stable uint32).
 *
 * @see https://docs.agora.io/en/video-calling/overview/product-overview
 */

const crypto = require("crypto");
const IRtcProvider = require("./rtcProvider.interface");

// Lazy-load to avoid crash if package not yet installed during partial deploys
let RtcTokenBuilder;
let RtcRole;
try {
  const agoraToken = require("agora-access-token");
  RtcTokenBuilder = agoraToken.RtcTokenBuilder;
  RtcRole = agoraToken.RtcRole;
} catch {
  // Module will throw at runtime if generateToken is called without the package
}

class AgoraProvider extends IRtcProvider {
  constructor() {
    super();
    this.appId = process.env.AGORA_APP_ID || "";
    this.appCertificate = process.env.AGORA_APP_CERTIFICATE || "";
    this.tokenExpireSeconds =
      parseInt(process.env.AGORA_TOKEN_EXPIRE_SECONDS, 10) || 3600;

    if (!this.appId) {
      console.warn(
        "[agoraProvider] AGORA_APP_ID is not set — token generation will fail at runtime",
      );
    }
    if (!this.appCertificate) {
      console.warn(
        "[agoraProvider] AGORA_APP_CERTIFICATE is not set — token generation will fail at runtime",
      );
    }
  }

  /**
   * Generate an Agora RTC token for a given channel and uid.
   *
   * @param {string} channelName - The Agora channel name
   * @param {number} uid - The numeric Agora UID (deterministic, never 0)
   * @param {string} [role="publisher"] - "publisher" or "subscriber"
   * @returns {string} The RTC token
   * @throws {Error} If agora-access-token is not installed or config is missing
   */
  generateToken(channelName, uid, role = "publisher") {
    if (!RtcTokenBuilder) {
      throw new Error(
        "agora-access-token package is not installed. Run: npm install agora-access-token",
      );
    }
    if (!this.appId || !this.appCertificate) {
      throw new Error(
        "AGORA_APP_ID and AGORA_APP_CERTIFICATE must be set in environment",
      );
    }
    if (!channelName) {
      throw new Error("channelName is required for token generation");
    }
    if (!uid || uid <= 0) {
      throw new Error("uid must be a positive integer (never 0)");
    }

    const agoraRole =
      role === "subscriber" ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;

    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpireTime = currentTime + this.tokenExpireSeconds;

    return RtcTokenBuilder.buildTokenWithUid(
      this.appId,
      this.appCertificate,
      channelName,
      uid,
      agoraRole,
      privilegeExpireTime,
      privilegeExpireTime,
    );
  }

  /**
   * Return the Agora App ID for client-side SDK initialization.
   *
   * @returns {string}
   */
  getAppId() {
    return this.appId;
  }

  /**
   * Generate a deterministic Agora UID from an application userId.
   *
   * Algorithm:
   *   MD5(userId) → readUInt32BE(0) → (value % 2147483647) + 1
   *
   * Guarantees:
   * - Deterministic: same userId always produces the same UID
   * - Never uid=0: the +1 offset ensures minimum value is 1
   * - Never random: pure function of userId, no Math.random()
   * - Stable across restarts: no server state involved
   * - Signed int32 safe: max 2,147,483,647 — safe for all Agora client SDKs
   *
   * @param {string|number} userId - The application user ID
   * @returns {number} A positive 32-bit integer (1..2,147,483,647)
   * @throws {Error} If userId is empty or invalid
   */
  generateUid(userId) {
    const id = String(userId ?? "").trim();
    if (!id) {
      throw new Error("userId is required for UID generation");
    }

    const hash = crypto.createHash("md5").update(id).digest();
    const raw = hash.readUInt32BE(0); // 0..4,294,967,295
    const uid = (raw % 2147483647) + 1; // 1..2,147,483,647 (never 0)
    return uid;
  }
}

module.exports = AgoraProvider;
