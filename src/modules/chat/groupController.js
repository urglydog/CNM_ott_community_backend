const groupService = require('./groupService');

async function createGroup(req, res) {
  try {
    const body = { ...req.body };
    // Lấy userId từ token auth, không lấy từ body
    if (req.user?.userId) {
      body.ownerId = req.user.userId;
    }
    const group = await groupService.createGroup(body);
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

async function getGroupMembers(req, res) {
  try {
    const groupId = req.params.groupId;
    console.log('[getGroupMembers] Dang tim members cho Group ID:', groupId);

    const members = await groupService.getGroupMembers(groupId);
    res.json(members);
  } catch (error) {
    console.error('[getGroupMembers] Loi lay danh sach thanh vien nhom:', error);
    res.status(500).json({
      message: 'Loi server',
      error: error.message,
    });
  }
}

async function getGroupsForUser(req, res) {
  try {
    const authUserId = req.user?.userId;
    const urlUserId = req.params.userId;
    console.log('[getGroupsForUser] authUserId:', authUserId, '| urlUserId:', urlUserId);
    let userKey;
    if (urlUserId) {
      userKey = String(urlUserId);
    } else if (authUserId) {
      userKey = String(authUserId);
    } else {
      return res.status(400).json({ message: 'User ID is required' });
    }
    const groups = await groupService.getGroupsForUser(userKey);
    res.json(groups);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getInviteInfo(req, res) {
  try {
    const { groupId } = req.params;
    const inviteData = await groupService.getInviteLink(groupId);
    res.json(inviteData);
  } catch (error) {
    if (error.message === 'Group not found') {
      res.status(404).json({ message: error.message });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
}

async function joinGroup(req, res) {
  try {
    const { inviteCode } = req.params;
    const userId = req.body?.userId || req.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized: user not authenticated' });
    }

    if (!inviteCode || typeof inviteCode !== 'string' || inviteCode.trim() === '') {
      return res.status(400).json({ message: 'Invalid invite code' });
    }

    const result = await groupService.joinGroupByInviteCode(userId, inviteCode.trim());
    res.status(201).json({ message: 'Joined group successfully', ...result });
  } catch (error) {
    if (error.message === 'Invalid invite code or group not found') {
      res.status(404).json({ message: error.message });
    } else if (error.message === 'User is already a member of this group') {
      res.status(400).json({ message: error.message });
    } else {
      console.error('[joinGroup] Error:', error);
      res.status(500).json({ message: 'Internal server error', details: error.message });
    }
  }
}

async function debugMembers(req, res) {
  try {
    const { userId } = req.params;
    const membersRes = await groupService.debugGetMembers(String(userId));
    res.json(membersRes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

module.exports = {
  createGroup,
  listGroups,
  getGroupById,
  addMemberToGroup,
  getGroupMembers,
  getGroupsForUser,
  getInviteInfo,
  joinGroup,
  debugMembers
};
