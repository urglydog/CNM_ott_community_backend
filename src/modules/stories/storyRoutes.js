const express = require("express");
const authMiddleware = require("../../middlewares/authMiddleware");
const storyController = require("./storyController");

const router = express.Router();

router.post("/", authMiddleware, storyController.createStory);
router.get("/feed", authMiddleware, storyController.getFeed);
router.get("/archive", authMiddleware, storyController.getArchive);
router.get("/highlights/:userId", authMiddleware, storyController.getHighlights);
router.put("/:storyId/highlight", authMiddleware, storyController.toggleHighlight);
router.put("/:storyId/like", authMiddleware, storyController.toggleLike);
router.post("/:storyId/reply", authMiddleware, storyController.replyToStory);

module.exports = router;
