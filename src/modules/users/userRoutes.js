const express = require('express');
const router = express.Router();

const userController = require('./userController');
const authMiddleware = require('../../common/middlewares/authMiddleware');

router.get('/me', authMiddleware, userController.getMe);
router.put('/profile', authMiddleware, userController.updateProfile);
router.post('/change-password', authMiddleware, userController.changePassword);

router.post('/verify/email/send', userController.sendEmailOTP);
router.post('/verify/email/confirm', userController.verifyEmailOTP);
router.post('/verify/phone/send', userController.sendPhoneOTP);
router.post('/verify/phone/confirm', userController.verifyPhoneOTP);

router.post('/recovery/start', userController.startPasswordRecovery);
router.post('/recovery/verify', userController.verifyPasswordRecoveryOTP);
router.post('/recovery/reset', userController.resetPasswordWithRecovery);

router.post('/reset-password', userController.resetPassword);

router.get('/:userId', userController.getUserById);
router.get('/', userController.listUsers);

module.exports = router;
