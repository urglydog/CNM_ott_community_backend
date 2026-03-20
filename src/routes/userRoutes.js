const express = require('express');
const router = express.Router();

const userController = require('../controllers/userController');
const authMiddleware = require('../middlewares/authMiddleware');

router.post('/register', userController.registerUser);
router.post('/login', userController.loginUser);
router.get('/me', authMiddleware, userController.getMe);
router.get('/:userId', userController.getUserById);
router.get('/', userController.listUsers);

module.exports = router;
