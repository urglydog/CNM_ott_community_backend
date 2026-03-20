const { ddbDocClient } = require('../config/awsConfig');
const { ScanCommand } = require('@aws-sdk/lib-dynamodb');

const USERS_TABLE = process.env.DDB_USERS_TABLE || 'ott_users';
const GROUPS_TABLE = process.env.DDB_GROUPS_TABLE || 'ott_groups';
const MESSAGES_TABLE = process.env.DDB_MESSAGES_TABLE || 'ott_messages';

async function countTable(tableName) {
  const result = await ddbDocClient.send(new ScanCommand({
    TableName: tableName,
    Select: 'COUNT'
  }));
  return result.Count || 0;
}

async function getOverviewStats() {
  const [users, groups, messages] = await Promise.all([
    countTable(USERS_TABLE),
    countTable(GROUPS_TABLE),
    countTable(MESSAGES_TABLE)
  ]);

  return {
    totalUsers: users,
    totalGroups: groups,
    totalMessages: messages
  };
}

module.exports = { getOverviewStats };
