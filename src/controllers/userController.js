const userService = require('../services/userService');

async function registerUser(req, res) {
  try {
    const user = await userService.registerUser(req.body);
    res.status(201).json(user);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function loginUser(req, res) {
  try {
    const user = await userService.loginUser(req.body);
    res.json(user);
  } catch (error) {
    res.status(400).json({ message: error.message });
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

module.exports = {
  registerUser,
  loginUser,
  getUserById,
  listUsers
};
