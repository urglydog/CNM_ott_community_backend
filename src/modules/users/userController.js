const userService = require('./userService');

async function getUserById(req, res) {
  try {
    const user = await userService.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function listUsers(req, res) {
  try {
    const users = await userService.listUsers();
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getMe(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Chưa xác thực' });
    }
    const user = await userService.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function updateProfile(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Chưa xác thực' });
    }

    const updatedUser = await userService.updateProfile(userId, req.body || {});

    // Emit socket event for real-time synchronization across web and mobile apps
    const io = req.app.get('io');
    if (io) {
      const { emitToUserSockets } = require('../../socket/socketUserRegistry');
      emitToUserSockets(io, userId, 'profile_updated', updatedUser);
    }

    return res.json({ message: 'Cập nhật hồ sơ thành công', user: updatedUser });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}

async function changePassword(req, res) {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?.sub;
    const username = req.user?.username;
    if (!userId) {
      return res.status(401).json({ message: 'Chưa xác thực' });
    }

    const { currentPassword, newPassword } = req.body || {};
    await userService.changePassword(userId, currentPassword, newPassword, username);
    return res.json({ message: 'Đổi mật khẩu thành công' });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}

async function sendEmailOTP(req, res) {
  try {
    const { email } = req.body || {};
    const otpInfo = await userService.sendEmailOTP(email);
    return res.json(otpInfo);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}

async function startPasswordRecovery(req, res) {
  try {
    const { identifier } = req.body || {};
    const result = await userService.sendPasswordRecoveryOTP(identifier);
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}

async function verifyPasswordRecoveryOTP(req, res) {
  try {
    const { recoveryToken, otp } = req.body || {};
    await userService.verifyPasswordRecoveryOTP(recoveryToken, otp);
    return res.json({ message: 'Xác thực OTP thành công.' });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}

async function resetPasswordWithRecovery(req, res) {
  try {
    const { recoveryToken, newPassword } = req.body || {};
    await userService.resetPasswordWithRecovery(recoveryToken, newPassword);
    return res.json({ message: 'Đặt lại mật khẩu thành công.' });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}

async function verifyEmailOTP(req, res) {
  try {
    const { email, otp } = req.body || {};
    await userService.verifyEmailOTP(email, otp);
    return res.json({ message: 'Xác thực email thành công.' });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}

async function sendPhoneOTP(req, res) {
  try {
    const { phone } = req.body || {};
    const otpInfo = await userService.sendPhoneOTP(phone);
    return res.json(otpInfo);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}

async function verifyPhoneOTP(req, res) {
  try {
    const { phone, otp } = req.body || {};
    await userService.verifyPhoneOTP(phone, otp);
    return res.json({ message: 'Xác thực số điện thoại thành công.' });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}

async function resetPassword(req, res) {
  try {
    const { identifier, otp, type, newPassword } = req.body || {};
    await userService.resetPassword({ identifier, otp, type, newPassword });
    return res.json({ message: 'Đặt lại mật khẩu thành công.' });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}

module.exports = {
  getUserById,
  listUsers,
  getMe,
  updateProfile,
  changePassword,
  sendEmailOTP,
  verifyEmailOTP,
  sendPhoneOTP,
  verifyPhoneOTP,
  startPasswordRecovery,
  verifyPasswordRecoveryOTP,
  resetPasswordWithRecovery,
  resetPassword,
};
