const express = require("express");

const router = express.Router();

const authMiddleware = require("../../common/middlewares/authMiddleware");
const notificationController = require("./notificationController");

router.get("/firebase-config", notificationController.getFirebaseConfig);
router.post("/devices", authMiddleware, notificationController.registerDevice);
router.delete("/devices", authMiddleware, notificationController.removeDevice);

module.exports = router;