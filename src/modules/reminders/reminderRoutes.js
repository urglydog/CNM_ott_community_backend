const express = require("express");

const authMiddleware = require("../../common/middlewares/authMiddleware");
const reminderController = require("./reminderController");

const router = express.Router();

router.use(authMiddleware);

router.get("/", reminderController.listReminders);
router.post("/", reminderController.createReminder);
router.get("/:reminderId", reminderController.getReminder);
router.patch("/:reminderId", reminderController.updateReminder);
router.delete("/:reminderId", reminderController.cancelReminder);

module.exports = router;
