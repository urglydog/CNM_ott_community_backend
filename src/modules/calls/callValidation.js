/**
 * Input validation functions for the call module.
 *
 * Pure validation — no side effects, no DB calls.
 * Throws descriptive errors on invalid input.
 */

const { CALL_TYPE, CALL_MODE } = require("./call.constants");

/**
 * Custom error class for call business errors.
 * Includes a machine-readable `code` for frontend handling.
 */
class CallError extends Error {
  /**
   * @param {string} message - Human-readable error message
   * @param {string} code - Machine-readable error code (e.g. "CALL_BUSY", "CALL_ENDED")
   * @param {number} [statusCode=400] - HTTP status code
   */
  constructor(message, code = "CALL_ERROR", statusCode = 400) {
    super(message);
    this.name = "CallError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ─── startCall Validation ───────────────────────────────────────────────────

/**
 * Validate inputs for starting a call.
 *
 * NOTE: callMode is NOT determined here — it comes from DB via resolveConversation().
 * Group audio rejection is handled in callService.startCall() after DB resolution.
 *
 * @param {Object} params
 * @param {string} params.userId - The caller's userId
 * @param {string} params.conversationId - The conversation to call in
 * @param {string} params.callType - "audio" or "video"
 * @returns {{ callType: string }}
 */
function validateStartCallInput({ userId, conversationId, callType }) {
  if (!userId) {
    throw new CallError("userId is required", "INVALID_INPUT", 401);
  }
  if (!conversationId || typeof conversationId !== "string" || !conversationId.trim()) {
    throw new CallError("conversationId is required", "INVALID_INPUT", 400);
  }

  const normalizedType = String(callType || "").toLowerCase().trim();
  if (normalizedType !== CALL_TYPE.AUDIO && normalizedType !== CALL_TYPE.VIDEO) {
    throw new CallError(
      `callType must be '${CALL_TYPE.AUDIO}' or '${CALL_TYPE.VIDEO}'`,
      "INVALID_INPUT",
      400,
    );
  }

  return { callType: normalizedType };
}

// ─── Generic Call ID Validation ─────────────────────────────────────────────

/**
 * Validate that a callId is present and non-empty.
 *
 * @param {string} callId
 */
function validateCallId(callId) {
  if (!callId || typeof callId !== "string" || !callId.trim()) {
    throw new CallError("callId is required", "INVALID_INPUT", 400);
  }
}

/**
 * Validate that a userId is present.
 *
 * @param {string} userId
 */
function validateUserId(userId) {
  if (!userId) {
    throw new CallError("userId is required", "INVALID_INPUT", 401);
  }
}

// ─── Pagination Validation ──────────────────────────────────────────────────

/**
 * Validate and normalize pagination parameters.
 *
 * @param {Object} query - Express req.query
 * @returns {{ limit: number, exclusiveStartKey?: Object }}
 */
function validatePagination(query = {}) {
  let limit = parseInt(query.limit, 10);
  if (isNaN(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;

  let exclusiveStartKey;
  if (query.cursor) {
    try {
      exclusiveStartKey = JSON.parse(
        Buffer.from(query.cursor, "base64").toString("utf8"),
      );
    } catch {
      throw new CallError("Invalid cursor parameter", "INVALID_INPUT", 400);
    }
  }

  return { limit, exclusiveStartKey };
}

/**
 * Encode a DynamoDB LastEvaluatedKey into a base64 cursor string.
 *
 * @param {Object} lastEvaluatedKey
 * @returns {string|null}
 */
function encodeCursor(lastEvaluatedKey) {
  if (!lastEvaluatedKey) return null;
  return Buffer.from(JSON.stringify(lastEvaluatedKey)).toString("base64");
}

module.exports = {
  CallError,
  validateStartCallInput,
  validateCallId,
  validateUserId,
  validatePagination,
  encodeCursor,
};
