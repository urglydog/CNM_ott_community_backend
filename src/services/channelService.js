const { ddbDocClient } = require('../config/awsConfig');
const { ScanCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

// Bảng kênh trong DynamoDB (primary key: channelId (S))
const CHANNELS_TABLE = process.env.DDB_CHANNELS_TABLE || 'ott_channels';

async function getChannelsByGroup(groupId) {
  const groupKey = String(groupId);

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: CHANNELS_TABLE,
    FilterExpression: '#gid = :gid',
    ExpressionAttributeNames: { '#gid': 'groupId' },
    ExpressionAttributeValues: { ':gid': groupKey }
  }));

  const rows = (result.Items || []).sort((a, b) => {
    const aTime = a.created_at || a.createdAt || '';
    const bTime = b.created_at || b.createdAt || '';
    return aTime.localeCompare(bTime);
  });

  return rows.map((row) => ({
    id: row.channelId,
    groupId: row.groupId,
    name: row.name,
    type: row.type,
    lastMessageId: row.last_messageId || row.last_message_id,
    createdAt: row.created_at || row.createdAt
  }));
}

async function getChannelById(channelId) {
  const result = await ddbDocClient.send(new ScanCommand({
    TableName: CHANNELS_TABLE,
    FilterExpression: '#cid = :cid',
    ExpressionAttributeNames: { '#cid': 'channelId' },
    ExpressionAttributeValues: { ':cid': String(channelId) }
  }));

  const rows = result.Items || [];
  if (!rows.length) return null;
  const row = rows[0];

  return {
    id: row.channelId,
    groupId: row.groupId,
    name: row.name,
    type: row.type,
    lastMessageId: row.last_messageId || row.last_message_id,
    createdAt: row.created_at || row.createdAt
  };
}

module.exports = {
  getChannelsByGroup,
  getChannelById
};
