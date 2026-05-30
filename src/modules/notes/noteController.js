const noteService = require("./noteService");
const { notifyMessageCreated } = require("../notifications/notificationService");

function getUserId(req) {
  return req.user?.userId ?? req.user?.id;
}

async function createNote(req, res) {
  try {
    const creatorId = getUserId(req);
    const result = await noteService.createNote({
      conversationId: req.body.conversationId || req.body.roomId,
      creatorId,
      content: req.body.content,
      pinToTop: req.body.pinToTop === true,
    });

    const io = req.app.get("socketio");
    if (io) {
      io.to(result.message.conversationId).emit("receive_message", result.message);
      if (result.pinnedMessages) {
        io.to(result.message.conversationId).emit("message_pinned_updated", {
          roomId: result.message.conversationId,
          pinnedMessages: result.pinnedMessages,
        });
      }
    }

    try {
      await notifyMessageCreated(result.message, io);
    } catch (notifyError) {
      console.error("[notes] notification failed:", notifyError.message);
    }

    res.status(201).json({ data: result });
  } catch (error) {
    res.status(error.status || 400).json({ message: error.message });
  }
}

module.exports = {
  createNote,
};
