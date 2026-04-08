const userService = require('../services/userService');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken
} = require('../utils/jwt');

function issueAuthTokens(user) {
  const userId = user.userId ?? user.id;
  const payload = { userId, username: user.username };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  return { accessToken, refreshToken };
}

async function registerUser(req, res) {
  try {
    const user = await userService.registerUser(req.body);
    const { accessToken, refreshToken } = issueAuthTokens(user);
    res.status(201).json({
      user,
      accessToken,
      refreshToken,
      token: accessToken
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function loginUser(req, res) {
  try {
    const user = await userService.loginUser(req.body);
    const { accessToken, refreshToken } = issueAuthTokens(user);
    res.json({
      user,
      accessToken,
      refreshToken,
      token: accessToken
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function refreshTokens(req, res) {
  try {
    const refreshTokenRaw = req.body?.refreshToken;
    if (!refreshTokenRaw || typeof refreshTokenRaw !== 'string') {
      return res.status(400).json({ message: 'refreshToken is required' });
    }
    const decoded = verifyRefreshToken(refreshTokenRaw);
    const userId = decoded.userId;
    const username = decoded.username;
    if (!userId || !username) {
      return res.status(401).json({ message: 'Invalid refresh token payload' });
    }
    const user = await userService.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User no longer exists' });
    }
    const accessToken = signAccessToken({ userId, username });
    const refreshToken = signRefreshToken({ userId, username });
    res.json({
      accessToken,
      refreshToken,
      token: accessToken
    });
  } catch (error) {
    res.status(401).json({ message: 'Invalid or expired refresh token' });
  }
}

async function getUserById(req, res) {
  try {
    const user = await userService.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
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
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const user = await userService.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

module.exports = {
  registerUser,
  loginUser,
  refreshTokens,
  getUserById,
  listUsers,
  getMe
};
