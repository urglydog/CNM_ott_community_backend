/**
 * Abstract RTC provider interface.
 *
 * All RTC provider implementations (Agora, Twilio, etc.) must extend this class
 * and implement every method. Business logic must depend on this interface —
 * never on a concrete provider directly.
 */

class IRtcProvider {
  /**
   * Generate an RTC token for a participant joining a channel.
   *
   * @param {string} channelName - The channel/call identifier
   * @param {number} uid - The numeric Agora UID (deterministic, never 0)
   * @param {string} role - The participant role (e.g. "publisher")
   * @returns {string} The RTC token string
   * @throws {Error} If token generation fails
   */
  generateToken(channelName, uid, role) {
    throw new Error("IRtcProvider.generateToken() not implemented");
  }

  /**
   * Return the provider's App ID (sent to clients for SDK initialization).
   *
   * @returns {string} The App ID
   */
  getAppId() {
    throw new Error("IRtcProvider.getAppId() not implemented");
  }

  /**
   * Generate a deterministic numeric UID from an application userId.
   * The same userId MUST always produce the same UID.
   * The UID MUST never be 0.
   *
   * @param {string|number} userId - The application user ID
   * @returns {number} A positive 32-bit integer suitable as an RTC UID
   * @throws {Error} If userId is empty or invalid
   */
  generateUid(userId) {
    throw new Error("IRtcProvider.generateUid() not implemented");
  }
}

module.exports = IRtcProvider;
