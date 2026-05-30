const storyService = require("./storyService");
const { notifyMessageCreated } = require("../notifications/notificationService");

function getUserId(req, res) {
  const userId = req.user?.userId;
  if (!userId) res.status(401).json({ message: "Chưa xác thực" });
  return userId;
}

async function createStory(req, res) {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;
    const story = await storyService.createStory(userId, req.body);
    res.status(201).json(story);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function getFeed(req, res) {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;
    res.json(await storyService.getFeed(userId));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getHighlights(req, res) {
  try {
    getUserId(req, res);
    if (res.headersSent) return;
    res.json(await storyService.getHighlights(req.params.userId));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getArchive(req, res) {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;
    res.json(await storyService.getArchive(userId));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function toggleHighlight(req, res) {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;
    res.json(await storyService.toggleHighlight(req.params.storyId, userId));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function toggleLike(req, res) {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;
    res.json(await storyService.toggleLike(req.params.storyId, userId));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function replyToStory(req, res) {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;
    const message = await storyService.replyToStory(req.params.storyId, userId, req.body?.content);
    const io = req.app.get("socketio");
    if (io) io.to(message.conversationId).emit("receive_message", message);
    await notifyMessageCreated(message, io);
    res.status(201).json(message);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

module.exports = {
  createStory,
  getFeed,
  getHighlights,
  getArchive,
  toggleHighlight,
  toggleLike,
  replyToStory,
};
