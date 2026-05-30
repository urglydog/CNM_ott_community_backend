const reminderService = require("./reminderService");
const { notifyMessageCreated } = require("../notifications/notificationService");

function getUserId(req) {
  return req.user?.userId ?? req.user?.id;
}

async function createReminder(req, res) {
  try {
    const creatorId = getUserId(req);
    const { reminder, message } = await reminderService.createReminder({
      conversationId: req.body.conversationId || req.body.roomId,
      creatorId,
      content: req.body.content,
      remindAt: req.body.remindAt,
      repeat: req.body.repeat,
    });

    const io = req.app.get("socketio");
    if (io) {
      io.to(message.conversationId).emit("receive_message", message);
    }
    try {
      await notifyMessageCreated(message, io);
    } catch (notifyError) {
      console.error("[reminders] notification failed:", notifyError.message);
    }

    res.status(201).json({ data: { reminder, message } });
  } catch (error) {
    res.status(error.status || 400).json({ message: error.message });
  }
}

async function listReminders(req, res) {
  try {
    const data = await reminderService.listReminders({
      userId: getUserId(req),
      conversationId: req.query.conversationId,
      status: req.query.status,
    });
    res.json({ data, count: data.length });
  } catch (error) {
    res.status(error.status || 400).json({ message: error.message });
  }
}

async function getReminder(req, res) {
  try {
    const reminder = await reminderService.getReminder(
      req.params.reminderId,
      getUserId(req),
    );
    if (!reminder) return res.status(404).json({ message: "Không tìm thấy nhắc hẹn" });
    res.json({ data: reminder });
  } catch (error) {
    res.status(error.status || 400).json({ message: error.message });
  }
}

async function updateReminder(req, res) {
  try {
    const reminder = await reminderService.updateReminder(
      req.params.reminderId,
      getUserId(req),
      req.body || {},
    );
    if (!reminder) return res.status(404).json({ message: "Không tìm thấy nhắc hẹn" });
    res.json({ data: reminder });
  } catch (error) {
    res.status(error.status || 400).json({ message: error.message });
  }
}

async function cancelReminder(req, res) {
  try {
    const reminder = await reminderService.cancelReminder(
      req.params.reminderId,
      getUserId(req),
    );
    if (!reminder) return res.status(404).json({ message: "Không tìm thấy nhắc hẹn" });
    res.json({ data: reminder });
  } catch (error) {
    res.status(error.status || 400).json({ message: error.message });
  }
}

module.exports = {
  cancelReminder,
  createReminder,
  getReminder,
  listReminders,
  updateReminder,
};
