const { ddbDocClient } = require('../../config/awsConfig');
const { PutCommand, GetCommand, ScanCommand, UpdateCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const crypto = require('crypto');

const { onlineUsers } = require('../../socket/socketUserRegistry');

const GROUPS_TABLE = process.env.DDB_GROUPS_TABLE || 'ott_groups';
const MEMBERS_TABLE = process.env.DDB_MEMBERS_TABLE || 'ott_group_members';
const REQUESTS_TABLE = process.env.DDB_GROUP_REQUESTS_TABLE || 'ott_group_requests';

function getActiveIO() {
  return require('../../socket/socketHandler').getIO();
}

function forceJoinGroup(userId, groupId) {
  const io = getActiveIO();
  if (!io) return;
  const sockets = onlineUsers.get(String(userId));
  if (sockets) {
    sockets.forEach(sockId => {
      const socket = io.sockets.sockets.get(sockId);
      if (socket) socket.join(String(groupId));
    });
  }
}

function forceLeaveGroup(userId, groupId) {
  const io = getActiveIO();
  if (!io) return;
  const sockets = onlineUsers.get(String(userId));
  if (sockets) {
    sockets.forEach(sockId => {
      const socket = io.sockets.sockets.get(sockId);
      if (socket) socket.leave(String(groupId));
    });
  }
}

function generateInviteCode() {
  return crypto.randomBytes(4).toString('hex');
}

async function createGroup(payload) {
  if (!payload.name) {
    throw new Error('Group name is required');
  }

  const now = new Date().toISOString();
  // groupId là khoá chính (string) trong DynamoDB
  const groupId = `group_${Date.now()}`;

  const ownerId = payload.ownerId || payload.createdBy || null;
  const userIds = Array.isArray(payload.userIds) ? payload.userIds.filter(u => u && String(u) !== String(ownerId)) : [];

  const groupItem = {
    groupId, // primary key DynamoDB
    name: payload.name,
    description: payload.description || '',
    avatar_url: null,
    type: payload.type || 'public_community',
    member_count: (ownerId ? 1 : 0) + userIds.length,
    created_by: ownerId,
    created_at: now,
    inviteCode: generateInviteCode(),
    isApprovalRequired: false,
    allowSendLinks: payload.allowSendLinks || 'ALL', // 'ALL' hoặc 'ADMINS_ONLY'
    spamFilterLevel: payload.spamFilterLevel !== undefined ? payload.spamFilterLevel : 1 // 0: Tắt, 1: Vừa, 2: Gắt gao
  };

  await ddbDocClient.send(new PutCommand({
    TableName: GROUPS_TABLE,
    Item: groupItem
  }));

  if (ownerId) {
    // Bảng thành viên nhóm dạng (group_id, user_id, role)
    await ddbDocClient.send(new PutCommand({
      TableName: MEMBERS_TABLE,
      Item: {
        groupId,
        userId: ownerId,
        role: 'OWNER',
        joined_at: now
      }
    }));
  }

  // Thêm các user khác từ mảng userIds
  if (userIds.length > 0) {
    for (const uid of userIds) {
      await ddbDocClient.send(new PutCommand({
        TableName: MEMBERS_TABLE,
        Item: {
          groupId,
          userId: String(uid),
          role: 'MEMBER',
          joined_at: now
        }
      }));
    }
  }

  return groupItem;
}

async function listGroups() {
  const result = await ddbDocClient.send(new ScanCommand({
    TableName: GROUPS_TABLE
  }));

  const rows = (result.Items || []).sort((a, b) => {
    const aTime = a.created_at || a.createdAt || '';
    const bTime = b.created_at || b.createdAt || '';
    return bTime.localeCompare(aTime);
  });

  return rows.map((g) => ({
    groupId: g.groupId,
    name: g.name,
    description: g.description,
    topic: g.type,
    avatarUrl: g.avatar_url,
    memberCount: g.member_count,
    createdBy: g.created_by,
    createdAt: g.created_at,
    isApprovalRequired: !!g.isApprovalRequired,
    allowSendLinks: g.allowSendLinks || 'ALL',
    spamFilterLevel: g.spamFilterLevel !== undefined ? g.spamFilterLevel : 1
  }));
}

async function getGroupById(groupId) {
  const result = await ddbDocClient.send(new GetCommand({
    TableName: GROUPS_TABLE,
    Key: { groupId: String(groupId) }
  }));

  if (!result.Item) return null;
  const g = result.Item;

  return {
    groupId: g.groupId,
    name: g.name,
    description: g.description,
    topic: g.type,
    avatarUrl: g.avatar_url,
    memberCount: g.member_count,
    createdBy: g.created_by,
    createdAt: g.created_at,
    isApprovalRequired: !!g.isApprovalRequired,
    pinnedMessages: g.pinnedMessages || [],
    allowSendLinks: g.allowSendLinks || 'ALL',
    spamFilterLevel: g.spamFilterLevel !== undefined ? g.spamFilterLevel : 1
  };
}

async function addMemberToGroup(groupId, userId, role = 'member') {
  const now = new Date().toISOString();
  const groupKey = String(groupId);
  const userKey = String(userId);

  await ddbDocClient.send(new PutCommand({
    TableName: MEMBERS_TABLE,
    Item: {
      groupId: groupKey,
      userId: userKey,
      role,
      joined_at: now
    }
  }));

  return { groupId: groupKey, userId: userKey, role };
}

async function addMembersToGroup(groupId, requestUserId, userIds) {
  const groupKey = String(groupId);
  const reqUserKey = String(requestUserId);

  const reqMemberRes = await ddbDocClient.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: reqUserKey }
  }));
  const reqMember = reqMemberRes.Item;

  if (!reqMember || (reqMember.role !== 'OWNER' && reqMember.role !== 'owner' && reqMember.role !== 'DEPUTY' && reqMember.role !== 'deputy')) {
    const err = new Error('403 Forbidden: Only OWNER or DEPUTY can add members');
    err.status = 403;
    throw err;
  }

  const membersRes = await ddbDocClient.send(new QueryCommand({
    TableName: MEMBERS_TABLE,
    KeyConditionExpression: 'groupId = :gid',
    ExpressionAttributeValues: { ':gid': groupKey }
  }));
  const currentMembers = membersRes.Items || [];
  const existingUserIds = currentMembers.map(m => m.userId);

  const newMembers = (Array.isArray(userIds) ? userIds : []).filter(uid => uid && !existingUserIds.includes(String(uid)) && String(uid) !== reqUserKey);

  const now = new Date().toISOString();
  const newMemberObjects = [];

  for (const uid of newMembers) {
    await ddbDocClient.send(new PutCommand({
      TableName: MEMBERS_TABLE,
      Item: {
        groupId: groupKey,
        userId: String(uid),
        role: 'MEMBER',
        joined_at: now
      }
    }));

    // Lấy thông tin user
    const uRes = await ddbDocClient.send(new GetCommand({
      TableName: process.env.DDB_USERS_TABLE || 'ott_users',
      Key: { userId: String(uid) }
    }));
    const u = uRes.Item || {};
    newMemberObjects.push({
      userId: String(uid),
      displayName: u.display_name || u.full_name || u.username || String(uid),
      username: u.username || u.display_name || String(uid),
      avatarUrl: u.avatar_url || null,
      role: 'MEMBER',
      joinedAt: now
    });
  }

  if (newMembers.length > 0) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: GROUPS_TABLE,
      Key: { groupId: groupKey },
      UpdateExpression: 'SET member_count = if_not_exists(member_count, :zero) + :inc',
      ExpressionAttributeValues: { ':inc': newMembers.length, ':zero': 0 }
    }));

    // Real-time
    newMembers.forEach(uid => forceJoinGroup(uid, groupKey));
    const io = getActiveIO();
    if (io) {
      io.to(groupKey).emit('SERVER:MEMBER_ADDED', {
        groupId: groupKey,
        addedMembers: newMemberObjects
      });
    }
  }

  return { addedCount: newMembers.length, addedMembers: newMemberObjects };
}

async function kickMember(groupId, requestUserId, targetUserId) {
  const groupKey = String(groupId);
  const reqUserKey = String(requestUserId);
  const targetKey = String(targetUserId);

  if (reqUserKey === targetKey) {
    const err = new Error('400 Bad Request: You cannot kick yourself. Please leave the group instead.');
    err.status = 400;
    throw err;
  }

  const reqMemberRes = await ddbDocClient.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: reqUserKey }
  }));
  const reqMember = reqMemberRes.Item;

  if (!reqMember) {
    const err = new Error('403 Forbidden: You are not in this group');
    err.status = 403;
    throw err;
  }

  const reqRole = (reqMember.role || 'MEMBER').toUpperCase();
  if (reqRole !== 'OWNER' && reqRole !== 'DEPUTY') {
    const err = new Error('403 Forbidden: Only OWNER or DEPUTY can kick members');
    err.status = 403;
    throw err;
  }

  const targetMemberRes = await ddbDocClient.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: targetKey }
  }));
  const targetMember = targetMemberRes.Item;

  if (!targetMember) {
    const err = new Error('404 Not Found: Target user is not in the group');
    err.status = 404;
    throw err;
  }

  const targetRole = (targetMember.role || 'MEMBER').toUpperCase();
  if (reqRole === 'DEPUTY' && targetRole !== 'MEMBER') {
    const err = new Error('403 Forbidden: DEPUTY can only kick roles of MEMBER level');
    err.status = 403;
    throw err;
  }

  await ddbDocClient.send(new DeleteCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: targetKey }
  }));

  await ddbDocClient.send(new UpdateCommand({
    TableName: GROUPS_TABLE,
    Key: { groupId: groupKey },
    UpdateExpression: 'SET member_count = member_count - :dec',
    ExpressionAttributeValues: { ':dec': 1 }
  }));

  forceLeaveGroup(targetKey, groupKey);
  const io = getActiveIO();
  if (io) {
    io.to(groupKey).emit('SERVER:MEMBER_KICKED', {
      groupId: groupKey,
      targetUserId: targetKey,
      actionBy: reqUserKey
    });
  }

  return { message: 'Member kicked successfully' };
}

async function updateRole(groupId, requestUserId, targetUserId, newRole) {
  const groupKey = String(groupId);
  const reqUserKey = String(requestUserId);
  const targetKey = String(targetUserId);
  const roleUpper = String(newRole).toUpperCase();

  if (roleUpper !== 'DEPUTY' && roleUpper !== 'MEMBER') {
    const err = new Error('400 Bad Request: newRole must be either DEPUTY or MEMBER');
    err.status = 400;
    throw err;
  }

  const reqMemberRes = await ddbDocClient.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: reqUserKey }
  }));
  const reqMember = reqMemberRes.Item;

  if (!reqMember || (reqMember.role || '').toUpperCase() !== 'OWNER') {
    const err = new Error('403 Forbidden: Only OWNER can update roles');
    err.status = 403;
    throw err;
  }

  const targetMemberRes = await ddbDocClient.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: targetKey }
  }));
  const targetMember = targetMemberRes.Item;

  if (!targetMember) {
    const err = new Error('404 Not Found: Target user is not in the group');
    err.status = 404;
    throw err;
  }

  if ((targetMember.role || '').toUpperCase() === 'OWNER') {
    const err = new Error('400 Bad Request: Cannot change the role of the OWNER using this API');
    err.status = 400;
    throw err;
  }

  await ddbDocClient.send(new UpdateCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: targetKey },
    UpdateExpression: 'SET #r = :roleVal',
    ExpressionAttributeNames: { '#r': 'role' },
    ExpressionAttributeValues: { ':roleVal': roleUpper }
  }));

  const io = getActiveIO();
  if (io) {
    io.to(groupKey).emit('SERVER:ROLE_UPDATED', {
      groupId: groupKey,
      targetUserId: targetKey,
      newRole: roleUpper
    });
  }

  return { message: 'Role updated successfully', newRole: roleUpper };
}

async function leaveGroup(groupId, requestUserId, newOwnerId = null) {
  const groupKey = String(groupId);
  const reqUserKey = String(requestUserId);

  const reqMemberRes = await ddbDocClient.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: reqUserKey }
  }));
  const reqMember = reqMemberRes.Item;

  if (!reqMember) {
    const err = new Error('404 Not Found: You are not a member of this group');
    err.status = 404;
    throw err;
  }

  // Get all members to check count
  const allMembersRes = await ddbDocClient.send(new QueryCommand({
    TableName: MEMBERS_TABLE,
    KeyConditionExpression: 'groupId = :gid',
    ExpressionAttributeValues: { ':gid': groupKey }
  }));
  const allMembers = allMembersRes.Items || [];

  if ((reqMember.role || '').toUpperCase() === 'OWNER') {
    if (allMembers.length > 1) {
      if (!newOwnerId) {
        const err = new Error('Bạn phải nhường quyền Trưởng nhóm (OWNER) cho người khác trước khi rời');
        err.status = 400;
        throw err;
      }
      
      const newOwnerKey = String(newOwnerId);
      const newOwner = allMembers.find(m => m.userId === newOwnerKey);
      if (!newOwner) {
        const err = new Error('Người được chọn làm Trưởng nhóm mới không có trong nhóm');
        err.status = 400;
        throw err;
      }

      // Promote new owner
      await ddbDocClient.send(new UpdateCommand({
        TableName: MEMBERS_TABLE,
        Key: { groupId: groupKey, userId: newOwnerKey },
        UpdateExpression: 'SET #role = :roleVal',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':roleVal': 'OWNER' }
      }));
      
      // Update creator in GROUPS_TABLE
      await ddbDocClient.send(new UpdateCommand({
        TableName: GROUPS_TABLE,
        Key: { groupId: groupKey },
        UpdateExpression: 'SET created_by = :newOwner',
        ExpressionAttributeValues: { ':newOwner': newOwnerKey }
      }));
      
      // Emit event owner_transferred
      const io = getActiveIO();
      if (io) {
        io.to(groupKey).emit('group:owner_transferred', { newOwnerId: newOwnerKey, oldOwnerId: reqUserKey });
        // And also update role socket for frontend compatibility
        io.to(groupKey).emit('SERVER:ROLE_UPDATED', { targetUserId: newOwnerKey, newRole: 'OWNER', groupId: groupKey });
      }
    } else {
      // It's the last member (owner), disband the group entirely
      return await disbandGroup(groupKey, reqUserKey);
    }
  }

  await ddbDocClient.send(new DeleteCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: reqUserKey }
  }));

  await ddbDocClient.send(new UpdateCommand({
    TableName: GROUPS_TABLE,
    Key: { groupId: groupKey },
    UpdateExpression: 'SET member_count = member_count - :dec',
    ExpressionAttributeValues: { ':dec': 1 }
  }));

  forceLeaveGroup(reqUserKey, groupKey);
  const io = getActiveIO();
  if (io) {
    io.to(groupKey).emit('SERVER:MEMBER_LEFT', {
      groupId: groupKey,
      userId: reqUserKey
    });
  }

  return { message: 'Successfully left the group' };
}

async function getGroupsForUser(userId) {
  const userKey = String(userId);

  const membersRes = await ddbDocClient.send(new ScanCommand({
    TableName: MEMBERS_TABLE,
    FilterExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userKey }
  }));

  const memberItems = membersRes.Items || [];
  if (!memberItems.length) return [];

  const groupIds = [...new Set(memberItems.map((m) => m.groupId))];
  const groups = await Promise.all(
    groupIds.map(async (gid) => {
      if (!gid) return null; // Bỏ qua nếu không có ID
      const res = await ddbDocClient.send(new GetCommand({
        TableName: GROUPS_TABLE,
        Key: { groupId: gid }
      }));
      return res.Item || null;
    })
  );

  return groups
    .filter(Boolean)
    .map((g) => ({
      groupId: g.groupId,
      name: g.name,
      description: g.description,
      topic: g.type,
      avatarUrl: g.avatar_url,
      memberCount: g.member_count,
      createdBy: g.created_by,
      createdAt: g.created_at,
      isApprovalRequired: !!g.isApprovalRequired,
      pinnedMessages: g.pinnedMessages || [],
      allowSendLinks: g.allowSendLinks || 'ALL',
      spamFilterLevel: g.spamFilterLevel !== undefined ? g.spamFilterLevel : 1
    }));
}

async function getGroupMembers(groupId) {
  const groupKey = String(groupId || '').trim();
  if (!groupKey) {
    throw new Error('Group ID is required');
  }

  const membersRes = await ddbDocClient.send(new QueryCommand({
    TableName: MEMBERS_TABLE,
    KeyConditionExpression: 'groupId = :gid',
    ExpressionAttributeValues: {
      ':gid': groupKey,
    },
  }));
  
  console.log('--- KẾT QUẢ QUERY MEMBERS ---', membersRes.Items);

  const members = membersRes.Items || [];
  if (!members.length) return [];

  const userProfiles = await Promise.all(
    members.map(async (member) => {
      const uid = String(member.userId || '');
      if (!uid) {
        return {
          userId: '',
          displayName: 'Unknown user',
          username: 'unknown',
          avatarUrl: null,
          role: member.role || 'member',
          joinedAt: member.joined_at || null,
        };
      }

      const userRes = await ddbDocClient.send(new GetCommand({
        TableName: process.env.DDB_USERS_TABLE || 'ott_users',
        Key: { userId: uid },
      }));

      const u = userRes.Item || {};
      return {
        userId: uid,
        displayName: u.display_name || u.full_name || u.username || uid,
        username: u.username || u.display_name || uid,
        avatarUrl: u.avatar_url || null,
        role: member.role || 'member',
        joinedAt: member.joined_at || null,
      };
    })
  );

  return userProfiles;
}

async function getInviteLink(groupId) {
  const group = await getGroupById(groupId);
  if (!group) {
    throw new Error('Group not found');
  }

  const result = await ddbDocClient.send(new GetCommand({
    TableName: GROUPS_TABLE,
    Key: { groupId: String(groupId) }
  }));

  const inviteCode = result.Item.inviteCode;
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000';
  const inviteLink = `${baseUrl}/join/${inviteCode}`;

  return { inviteCode, inviteLink };
}

async function joinGroupByInviteCode(userId, inviteCode) {
  // Normalize inviteCode to lowercase to match DynamoDB storage (generated via crypto.randomBytes)
  const normalizedCode = String(inviteCode).trim().toLowerCase();

  // Tìm nhóm qua inviteCode — dùng Scan thay vì Query vì bảng chưa có GSI inviteCode-index
  const scanRes = await ddbDocClient.send(new ScanCommand({
    TableName: GROUPS_TABLE,
    FilterExpression: 'inviteCode = :code',
    ExpressionAttributeValues: { ':code': normalizedCode }
  }));

  if (!scanRes.Items || scanRes.Items.length === 0) {
    throw new Error('Invalid invite code or group not found');
  }

  const group = scanRes.Items[0];
  const groupId = group.groupId;
  const userKey = String(userId);
  const needsApproval = group.isApprovalRequired || false;

  const memberCheck = await ddbDocClient.send(new ScanCommand({
    TableName: MEMBERS_TABLE,
    FilterExpression: 'groupId = :gid AND userId = :uid',
    ExpressionAttributeValues: {
      ':gid': groupId,
      ':uid': userKey
    }
  }));

  if (memberCheck.Items && memberCheck.Items.length > 0) {
    throw new Error('User is already a member of this group');
  }

  if (needsApproval) {
    const reqRes = await requestToJoin(groupId, userId);
    return { ...reqRes, status: 'PENDING' };
  }

  await addMemberToGroup(groupId, userKey, 'MEMBER');

  await ddbDocClient.send(new UpdateCommand({
    TableName: GROUPS_TABLE,
    Key: { groupId },
    UpdateExpression: 'SET member_count = if_not_exists(member_count, :zero) + :inc',
    ExpressionAttributeValues: {
      ':inc': 1,
      ':zero': 0
    }
  }));

  const uRes = await ddbDocClient.send(new GetCommand({
    TableName: process.env.DDB_USERS_TABLE || 'ott_users',
    Key: { userId: userKey }
  }));
  const u = uRes.Item || {};
  const newMemberObj = {
    userId: userKey,
    displayName: u.display_name || u.full_name || u.username || userKey,
    username: u.username || u.display_name || userKey,
    avatarUrl: u.avatar_url || null,
    role: 'MEMBER',
    joinedAt: new Date().toISOString()
  };

  forceJoinGroup(userKey, groupId);
  const io = getActiveIO();
  if (io) {
    io.to(groupId).emit('SERVER:MEMBER_ADDED', {
      groupId,
      addedMembers: [newMemberObj]
    });
  }

  return { groupId, userId: userKey, role: 'MEMBER', status: 'JOINED' };
}

async function updateGroupSettings(groupId, requestUserId, settings) {
  const groupKey = String(groupId);
  const reqUserKey = String(requestUserId);

  const reqMemberRes = await ddbDocClient.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: reqUserKey }
  }));
  const reqMember = reqMemberRes.Item;

  if (!reqMember || (reqMember.role !== 'OWNER' && reqMember.role !== 'owner')) {
    const err = new Error('403 Forbidden: Only OWNER can update settings');
    err.status = 403;
    throw err;
  }

  let updateExpr = 'SET ';
  const exprValues = {};
  const exprNames = {};
  let changed = false;

  if (settings.isApprovalRequired !== undefined) {
    updateExpr += '#isAppReq = :isAppReq, ';
    exprNames['#isAppReq'] = 'isApprovalRequired';
    exprValues[':isAppReq'] = Boolean(settings.isApprovalRequired);
    changed = true;
  }

  if (settings.allowSendLinks !== undefined) {
    updateExpr += '#allowSend = :allowSend, ';
    exprNames['#allowSend'] = 'allowSendLinks';
    exprValues[':allowSend'] = String(settings.allowSendLinks);
    changed = true;
  }

  if (settings.spamFilterLevel !== undefined) {
    updateExpr += '#spamLvl = :spamLvl, ';
    exprNames['#spamLvl'] = 'spamFilterLevel';
    exprValues[':spamLvl'] = Number(settings.spamFilterLevel);
    changed = true;
  }

  // Bỏ dấu phẩy thừa ở cuối
  updateExpr = updateExpr.replace(/, $/, '');

  if (changed) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: GROUPS_TABLE,
      Key: { groupId: groupKey },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues
    }));

    const io = getActiveIO();
    if (io) {
      io.to(groupKey).emit('SERVER:GROUP_SETTINGS_UPDATED', {
        groupId: groupKey,
        settings: {
          isApprovalRequired: settings.isApprovalRequired,
          allowSendLinks: settings.allowSendLinks,
          spamFilterLevel: settings.spamFilterLevel
        }
      });
    }
  }

  return { message: 'Settings updated successfully' };
}

async function debugGetMembers(userId) {
  const userKey = String(userId);
  const result = await ddbDocClient.send(new ScanCommand({
    TableName: MEMBERS_TABLE,
    FilterExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userKey }
  }));
  return result.Items || [];
}

async function disbandGroup(groupId, requestUserId) {
  const groupKey = String(groupId);
  const userKey = String(requestUserId);

  const membersRes = await ddbDocClient.send(new QueryCommand({
    TableName: MEMBERS_TABLE,
    KeyConditionExpression: 'groupId = :gid',
    ExpressionAttributeValues: { ':gid': groupKey }
  }));
  
  const members = membersRes.Items || [];
  const requester = members.find(m => m.userId === userKey);
  
  if (!requester || (requester.role !== 'owner' && requester.role !== 'OWNER')) {
    const error = new Error('403 Forbidden: You are not the OWNER of this group');
    error.status = 403;
    throw error;
  }
  
  // delete members
  for (const m of members) {
    await ddbDocClient.send(new DeleteCommand({
      TableName: MEMBERS_TABLE,
      Key: { groupId: groupKey, userId: m.userId }
    }));
  }

  // Xoá nhóm
  await ddbDocClient.send(new DeleteCommand({
    TableName: GROUPS_TABLE,
    Key: { groupId: groupKey }
  }));

  const io = getActiveIO();
  if (io) {
    io.to(groupKey).emit('SERVER:GROUP_DISBANDED', {
      groupId: groupKey
    });
  }
  
  for (const m of members) {
    forceLeaveGroup(m.userId, groupKey);
  }

  return { message: 'Group disbanded successfully' };
}

async function requestToJoin(groupId, userId) {
  const groupKey = String(groupId);
  const userKey = String(userId);
  const now = new Date().toISOString();

  // Kiểm tra đã là thành viên chưa
  const memberCheck = await ddbDocClient.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: userKey }
  }));
  if (memberCheck.Item) {
    const error = new Error('400 Bad Request: You are already a member');
    error.status = 400;
    throw error;
  }

  await ddbDocClient.send(new PutCommand({
    TableName: REQUESTS_TABLE,
    Item: {
      groupId: groupKey,
      userId: userKey,
      status: 'PENDING',
      createdAt: now
    }
  }));

  const io = getActiveIO();
  if (io) {
    io.to(groupKey).emit('SERVER:NEW_JOIN_REQUEST', {
      groupId: groupKey,
      userId: userKey
    });
  }

  return { message: 'Request sent successfully' };
}

async function getPendingRequests(groupId) {
  const groupKey = String(groupId);

  const reqsRes = await ddbDocClient.send(new QueryCommand({
    TableName: REQUESTS_TABLE,
    KeyConditionExpression: 'groupId = :gid',
    ExpressionAttributeValues: { ':gid': groupKey }
  }));

  const requests = reqsRes.Items || [];
  const pendingReqs = requests.filter(r => r.status === 'PENDING');

  if (!pendingReqs.length) return [];

  const profiles = await Promise.all(
    pendingReqs.map(async (req) => {
      const uRes = await ddbDocClient.send(new GetCommand({
        TableName: process.env.DDB_USERS_TABLE || 'ott_users',
        Key: { userId: req.userId }
      }));
      const u = uRes.Item || {};
      return {
        userId: req.userId,
        status: req.status,
        createdAt: req.createdAt,
        displayName: u.display_name || u.full_name || u.username || req.userId,
        avatarUrl: u.avatar_url || null,
      };
    })
  );

  return profiles;
}

async function handleJoinRequest(groupId, requestUserId, targetUserId, action) {
  const groupKey = String(groupId);
  const reqUserKey = String(requestUserId);
  const targetKey = String(targetUserId);

  const reqMemberRes = await ddbDocClient.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: reqUserKey }
  }));
  const reqMember = reqMemberRes.Item;

  if (!reqMember || (reqMember.role !== 'OWNER' && reqMember.role !== 'DEPUTY' && reqMember.role !== 'owner' && reqMember.role !== 'deputy')) {
    const error = new Error('403 Forbidden: Only OWNER or DEPUTY can handle requests');
    error.status = 403;
    throw error;
  }

  const joinReqRes = await ddbDocClient.send(new GetCommand({
    TableName: REQUESTS_TABLE,
    Key: { groupId: groupKey, userId: targetKey }
  }));

  if (!joinReqRes.Item) {
    const error = new Error('404 Not Found: Request not found');
    error.status = 404;
    throw error;
  }

  if (action === 'APPROVE') {
    await ddbDocClient.send(new DeleteCommand({
      TableName: REQUESTS_TABLE,
      Key: { groupId: groupKey, userId: targetKey }
    }));
    
    await addMemberToGroup(groupKey, targetKey, 'MEMBER');

    const uRes = await ddbDocClient.send(new GetCommand({
      TableName: process.env.DDB_USERS_TABLE || 'ott_users',
      Key: { userId: targetKey }
    }));
    const u = uRes.Item || {};
    const newMemberObj = {
      userId: targetKey,
      displayName: u.display_name || u.full_name || u.username || targetKey,
      username: u.username || u.display_name || targetKey,
      avatarUrl: u.avatar_url || null,
      role: 'MEMBER',
      joinedAt: new Date().toISOString()
    };

    await ddbDocClient.send(new UpdateCommand({
      TableName: GROUPS_TABLE,
      Key: { groupId: groupKey },
      UpdateExpression: 'SET member_count = if_not_exists(member_count, :zero) + :inc',
      ExpressionAttributeValues: { ':inc': 1, ':zero': 0 }
    }));
    
    forceJoinGroup(targetKey, groupKey);
    const io = getActiveIO();
    if (io) {
      io.to(groupKey).emit('SERVER:MEMBER_ADDED', {
        groupId: groupKey,
        addedMembers: [newMemberObj]
      });
      // also emit to targetUser privately so their UI updates
      io.to(targetKey).emit('SERVER:JOIN_REQUEST_APPROVED', { groupId: groupKey });
    }
    return { message: 'Request approved' };
  } else if (action === 'REJECT') {
    await ddbDocClient.send(new DeleteCommand({
      TableName: REQUESTS_TABLE,
      Key: { groupId: groupKey, userId: targetKey }
    }));
    return { message: 'Request rejected' };
  } else {
    const error = new Error('400 Bad Request: Invalid action');
    error.status = 400;
    throw error;
  }
}

module.exports = {
  createGroup,
  listGroups,
  getGroupById,
  addMemberToGroup,
  addMembersToGroup,
  kickMember,
  updateRole,
  leaveGroup,
  getGroupMembers,
  getGroupsForUser,
  getInviteLink,
  joinGroupByInviteCode,
  debugGetMembers,
  debugGetMembers,
  disbandGroup,
  requestToJoin,
  getPendingRequests,
  handleJoinRequest,
  updateGroupSettings,
  pinMessage,
  unpinMessage,
};

async function pinMessage(groupId, message, requestUserId) {
  const groupKey = String(groupId);
  const result = await ddbDocClient.send(new GetCommand({
    TableName: GROUPS_TABLE,
    Key: { groupId: groupKey }
  }));
  const g = result.Item;
  if (!g) throw new Error('Group not found');

  // Kiểm tra quyền (OWNER/DEPUTY)
  const memberRes = await ddbDocClient.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: String(requestUserId) }
  }));
  const member = memberRes.Item;
  if (!member || (member.role !== 'OWNER' && member.role !== 'owner' && member.role !== 'DEPUTY' && member.role !== 'deputy')) {
    throw new Error('Only OWNER or DEPUTY can pin messages');
  }

  let pinned = Array.isArray(g.pinnedMessages) ? g.pinnedMessages : [];
  pinned = pinned.filter(m => String(m.id) !== String(message.id));

  const pinObj = {
    ...message,
    pinnedBy: String(requestUserId),
    pinnedAt: new Date().toISOString()
  };
  pinned.unshift(pinObj);

  await ddbDocClient.send(new UpdateCommand({
    TableName: GROUPS_TABLE,
    Key: { groupId: groupKey },
    UpdateExpression: 'SET pinnedMessages = :p',
    ExpressionAttributeValues: { ':p': pinned }
  }));

  return pinned;
}

async function unpinMessage(groupId, messageId, requestUserId) {
  const groupKey = String(groupId);
  const result = await ddbDocClient.send(new GetCommand({
    TableName: GROUPS_TABLE,
    Key: { groupId: groupKey }
  }));
  const g = result.Item;
  if (!g) throw new Error('Group not found');

  // Kiểm tra quyền
  const memberRes = await ddbDocClient.send(new GetCommand({
    TableName: MEMBERS_TABLE,
    Key: { groupId: groupKey, userId: String(requestUserId) }
  }));
  const member = memberRes.Item;
  if (!member || (member.role !== 'OWNER' && member.role !== 'owner' && member.role !== 'DEPUTY' && member.role !== 'deputy')) {
    throw new Error('Only OWNER or DEPUTY can unpin messages');
  }

  let pinned = Array.isArray(g.pinnedMessages) ? g.pinnedMessages : [];

  // Kiểm tra quyền: 
  // 1. Nếu là OWNER/DEPUTY thì được gỡ mọi ghim
  // 2. Nếu là MEMBER thì chỉ được gỡ ghim do chính mình tạo
  const pinToUnpin = pinned.find(m => String(m.id) === String(messageId));
  
  const isPinner = pinToUnpin && String(pinToUnpin.pinnedBy) === String(requestUserId);
  const isHighRole = member && (member.role === 'OWNER' || member.role === 'owner' || member.role === 'DEPUTY' || member.role === 'deputy');

  if (pinToUnpin && pinToUnpin.pinnedBy && !isPinner && !isHighRole) {
    throw new Error('Bạn không có quyền gỡ tin nhắn này');
  }

  pinned = pinned.filter(m => String(m.id) !== String(messageId));

  await ddbDocClient.send(new UpdateCommand({
    TableName: GROUPS_TABLE,
    Key: { groupId: groupKey },
    UpdateExpression: 'SET pinnedMessages = :p',
    ExpressionAttributeValues: { ':p': pinned }
  }));

  return pinned;
}
