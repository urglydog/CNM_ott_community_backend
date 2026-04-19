/**
 * Shared in-memory registry of online users.
 * Maps userId (string) -> Set of socket.id.
 * Used by both:
 *   - socketHandler.js  → registers sockets on connect / unregisters on disconnect
 *   - messageRevokeController.js → emits "message:revoked" directly to participant sockets
 */
const onlineUsers = new Map();

function registerSocket(userId, socketId) {
  if (!userId || !socketId) return;
  const key = String(userId);
  if (!onlineUsers.has(key)) onlineUsers.set(key, new Set());
  onlineUsers.get(key).add(socketId);
}

function unregisterSocket(userId, socketId) {
  if (!userId || !socketId) return;
  const key = String(userId);
  const sockets = onlineUsers.get(key);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) onlineUsers.delete(key);
}

function emitToUserSockets(io, userId, event, payload) {
  const key = String(userId ?? "").trim();
  if (!key) return false;

  const sockets = onlineUsers.get(key);
  if (!sockets || sockets.size === 0) return false;

  for (const socketId of sockets) {
    io.to(socketId).emit(event, payload);
  }
  return true;
}

module.exports = { onlineUsers, registerSocket, unregisterSocket, emitToUserSockets };
