const { saveMessage } = require('./messageService');

function handleSocketConnection(io, socket) {
  socket.on('join-conversation', (conversationId) => {
    if (!conversationId) return;
    socket.join(conversationId);
  });

  socket.on('call-request', (payload = {}) => {
    const { conversationId } = payload;
    if (!conversationId) return;

    // In a 1-1 room, this forwards the incoming call signal to the other peer.
    socket.to(conversationId).emit('incoming-call', payload);
  });

  socket.on('call-accepted', (payload = {}) => {
    const { conversationId } = payload;
    if (!conversationId) return;

    socket.to(conversationId).emit('call-accepted', payload);
  });

  socket.on('call-rejected', (payload = {}) => {
    const { conversationId } = payload;
    if (!conversationId) return;

    socket.to(conversationId).emit('call-rejected', payload);
  });

  socket.on('end-call', (payload = {}) => {
    const { conversationId } = payload;
    if (!conversationId) return;

    socket.to(conversationId).emit('end-call', payload);
  });

  socket.on('send-message', async (payload, callback) => {
    try {
      const message = await saveMessage(payload);
      if (message && message.conversationId) {
        io.to(message.conversationId).emit('new-message', message);
      }
      if (callback) callback({ ok: true, message });
    } catch (error) {
      if (callback) callback({ ok: false, error: error.message });
    }
  });

  socket.on('disconnect', () => {
    // Handle cleanup if needed
  });
}

module.exports = { handleSocketConnection };
