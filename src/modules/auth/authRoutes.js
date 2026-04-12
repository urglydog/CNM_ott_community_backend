const express = require('express');
const router = express.Router();
const authController = require('./authController');

router.post('/register', authController.registerUser);
router.post('/login', authController.loginUser);
router.post('/refresh', authController.refreshTokens);

module.exports = router;
