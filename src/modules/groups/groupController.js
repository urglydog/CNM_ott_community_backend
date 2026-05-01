const groupService = require('./groupService');
const { emitToUserSockets } = require('../../socket/socketUserRegistry');

function getSocketHandler() {
  return require('../../socket/socketHandler');
}
function joinUserToRoom(...args) { return getSocketHandler().joinUserToRoom(...args); }
function leaveUserFromRoom(...args) { return getSocketHandler().leaveUserFromRoom(...args); }
function emitToRoom(...args) { return getSocketHandler().emitToRoom(...args); }
function getIO() { return getSocketHandler().getIO(); }

async function createGroup(req, res) {
  try {
    const body = { ...req.body };
    // Lấy userId từ token auth, không lấy từ body
    if (req.user?.userId) {
      body.ownerId = req.user.userId;
    }
    const group = await groupService.createGroup(body);
    
    // Join owner vào room socket
    if (body.ownerId) {
      joinUserToRoom(body.ownerId, group.groupId);
      const io = getIO();
      if (io) {
        emitToUserSockets(io, body.ownerId, "chat:new_conversation", { conversationData: group });
      }
    }

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

async function disbandGroup(req, res) {
  try {
    const { groupId } = req.params;
    const requestUserId = req.user?.userId || req.user?.id;
    
    if (!requestUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    
    await groupService.disbandGroup(groupId, requestUserId);

    // Báo cho cả phòng chat biết nhóm đã bị giải tán
    emitToRoom(groupId, "group:deleted", { groupId, disbandedBy: requestUserId });

    const io = getIO();
    if (io) {
      io.in(groupId).socketsLeave(groupId);
    }

    res.status(200).json({ message: 'Group disbanded successfully' });
  } catch (error) {
    if (error.status === 403) {
      res.status(403).json({ message: error.message });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
}

async function addMembers(req, res) {
  try {
    const { groupId } = req.params;
    const requestUserId = req.user?.userId || req.user?.id;
    const { userIds } = req.body;

    if (!requestUserId) return res.status(401).json({ message: 'Unauthorized' });

    const result = await groupService.addMembersToGroup(groupId, requestUserId, userIds);

    // Fetch thông tin nhóm để gửi cho frontend
    const groupData = await groupService.getGroupById(groupId);

    // Báo cho các user mới biết họ được add
    const io = getIO();
    userIds.forEach(uid => {
      joinUserToRoom(uid, groupId);
      if (io) {
        emitToUserSockets(io, uid, "group:you_were_added", { groupData, addedBy: requestUserId });
        emitToUserSockets(io, uid, "chat:new_conversation", { conversationData: groupData });
      }
    });

    // Báo cho cả phòng biết có người mới
    emitToRoom(groupId, "group:members_added", { 
      groupId, 
      newMembers: userIds, 
      addedBy: requestUserId 
    });

    res.status(201).json(result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: error.message });
  }
}

async function kickMember(req, res) {
  try {
    const { groupId, userId } = req.params; // targetUserId
    const requestUserId = req.user?.userId || req.user?.id;

    if (!requestUserId) return res.status(401).json({ message: 'Unauthorized' });

    const result = await groupService.kickMember(groupId, requestUserId, userId);

    const msgSvc = require('../messages/messageService');
    const systemMsg = await msgSvc.saveMessage({
      conversationId: groupId,
      senderId: requestUserId,
      contentType: 'system',
      content: 'đã xóa một thành viên khỏi nhóm'
    });

    // Báo cho phòng chat biết có người bị kick
    emitToRoom(groupId, "group:member_removed", { 
      groupId, 
      removedMember: userId,
      kickedBy: requestUserId,
      systemMessage: systemMsg
    });

    // Bắn thẳng tin nhắn hệ thống vào phòng chat
    emitToRoom(groupId, "receive_message", systemMsg);

    // Báo cho người bị kick biết và bắt họ leave room
    const io = getIO();
    if(io) {
      emitToUserSockets(io, userId, "group:you_were_removed", { groupId });
    }
    leaveUserFromRoom(userId, groupId);

    res.status(200).json(result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: error.message });
  }
}

async function updateRole(req, res) {
  try {
    const { groupId, userId } = req.params; // targetUserId
    const { role } = req.body; // newRole
    const requestUserId = req.user?.userId || req.user?.id;

    if (!requestUserId) return res.status(401).json({ message: 'Unauthorized' });

    const result = await groupService.updateRole(groupId, requestUserId, userId, role);
    res.status(200).json(result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: error.message });
  }
}

async function leaveGroup(req, res) {
  try {
    const { groupId } = req.params;
    const requestUserId = req.user?.userId || req.user?.id;
    const newOwnerId = req.body?.newOwnerId;

    if (!requestUserId) return res.status(401).json({ message: 'Unauthorized' });

    const result = await groupService.leaveGroup(groupId, requestUserId, newOwnerId);

    const msgSvc = require('../messages/messageService');
    const systemMsg = await msgSvc.saveMessage({
      conversationId: groupId,
      senderId: requestUserId,
      contentType: 'system',
      content: 'đã rời nhóm'
    });

    // Báo cho cả phòng biết có người tự out
    emitToRoom(groupId, "group:member_left", { 
      groupId, 
      leftMember: requestUserId,
      systemMessage: systemMsg
    });

    // Bắn thẳng tin nhắn hệ thống vào phòng chat
    emitToRoom(groupId, "receive_message", systemMsg);

    // Rời khỏi phòng chat
    leaveUserFromRoom(requestUserId, groupId);

    res.status(200).json(result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: error.message });
  }
}

async function requestToJoin(req, res) {
  try {
    const { groupId } = req.params;
    const userId = req.user?.userId || req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const result = await groupService.requestToJoin(groupId, userId);
    res.status(201).json(result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: error.message });
  }
}

async function getPendingRequests(req, res) {
  try {
    const { groupId } = req.params;
    const result = await groupService.getPendingRequests(groupId);
    res.status(200).json(result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: error.message });
  }
}

async function handleJoinRequest(req, res) {
  try {
    const { groupId, userId } = req.params; // userId là targetUserId (người xin vào bù)
    const { action } = req.body;
    const requestUserId = req.user?.userId || req.user?.id;

    if (!requestUserId) return res.status(401).json({ message: 'Unauthorized' });

    const result = await groupService.handleJoinRequest(groupId, requestUserId, userId, action);
    res.status(200).json(result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: error.message });
  }
}

async function updateGroupSettings(req, res) {
  try {
    const { groupId } = req.params;
    const requestUserId = req.user?.userId || req.user?.id;

    if (!requestUserId) return res.status(401).json({ message: 'Unauthorized' });

    const result = await groupService.updateGroupSettings(groupId, requestUserId, req.body || {});
    res.status(200).json(result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: error.message });
  }
}

module.exports = {
  createGroup,
  listGroups,
  getGroupById,
  addMemberToGroup,
  addMembers,
  kickMember,
  updateRole,
  leaveGroup,
  getGroupMembers,
  getGroupsForUser,
  getInviteInfo,
  joinGroup,
  debugMembers,
  disbandGroup,
  requestToJoin,
  getPendingRequests,
  handleJoinRequest,
  updateGroupSettings
};
