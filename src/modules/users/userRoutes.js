const express = require('express');
const router = express.Router();

const userController = require('./userController');
const authMiddleware = require('../../common/middlewares/authMiddleware');

router.get('/me', authMiddleware, userController.getMe);
router.get('/:userId', userController.getUserById);
router.get('/', userController.listUsers);

module.exports = router;
