const { ddbDocClient } = require('../config/awsConfig');
const { PutCommand, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const GROUPS_TABLE = process.env.DDB_GROUPS_TABLE || 'ott_groups';
const MEMBERS_TABLE = process.env.DDB_MEMBERS_TABLE || 'ott_group_members';

async function createGroup(payload) {
  if (!payload.name) {
    throw new Error('Group name is required');
  }

  const now = new Date().toISOString();
  // groupId là khoá chính (string) trong DynamoDB
  const groupId = `group_${Date.now()}`;

  const ownerId = payload.ownerId || payload.createdBy || null;

  const groupItem = {
    groupId, // primary key DynamoDB
    name: payload.name,
    description: payload.description || '',
    avatar_url: null,
    type: payload.type || 'public_community',
    member_count: ownerId ? 1 : 0,
    created_by: ownerId,
    created_at: now
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
        group_id: groupId,
        user_id: ownerId,
        role: 'owner',
        joined_at: now
      }
    }));
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
    createdAt: g.created_at
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
    createdAt: g.created_at
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

async function getGroupsForUser(userId) {
  const userKey = String(userId);

  // Không có GSI nên dùng Scan + filter theo user_id
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
      createdAt: g.created_at
    }));
}

module.exports = {
  createGroup,
  listGroups,
  getGroupById,
  addMemberToGroup,
  getGroupsForUser
};
