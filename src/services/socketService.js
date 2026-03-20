const { saveMessage } = require('./messageService');

function handleSocketConnection(io, socket) {
  socket.on('join-conversation', (conversationId) => {
    if (!conversationId) return;
    socket.join(conversationId);
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
