const groupService = require('../services/groupService');

async function createGroup(req, res) {
  try {
    const group = await groupService.createGroup(req.body);
    res.status(201).json(group);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function listGroups(req, res) {
  try {
    const groups = await groupService.listGroups();
    res.json(groups);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getGroupById(req, res) {
  try {
    const group = await groupService.getGroupById(req.params.groupId);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    res.json(group);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function addMemberToGroup(req, res) {
  try {
    const membership = await groupService.addMemberToGroup(req.params.groupId, req.body.userId, req.body.role);
    res.status(201).json(membership);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function getGroupsForUser(req, res) {
  try {
    const groups = await groupService.getGroupsForUser(req.params.userId);
    res.json(groups);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

module.exports = {
  createGroup,
  listGroups,
  getGroupById,
  addMemberToGroup,
  getGroupsForUser
};
