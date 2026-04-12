const { ddbDocClient } = require('../../config/awsConfig');
const { GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const USERS_TABLE = process.env.DDB_USERS_TABLE || 'ott_users';

async function getUserById(userId) {
  if (!userId) return null;

  const keyUserId = String(userId);
  const result = await ddbDocClient.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { userId: keyUserId }
  }));

  if (result.Item) {
    const { password_hash, ...userWithoutPassword } = result.Item;
    return userWithoutPassword;
  }

  const numericId = Number(userId);
  if (!Number.isNaN(numericId)) {
    const scanRes = await ddbDocClient.send(new ScanCommand({
      TableName: USERS_TABLE,
      FilterExpression: '#id = :id',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': numericId }
    }));

    if (scanRes.Items && scanRes.Items.length > 0) {
      const { password_hash, ...userWithoutPassword } = scanRes.Items[0];
      return userWithoutPassword;
    }
  }

  return null;
}

async function listUsers() {
  const result = await ddbDocClient.send(new ScanCommand({
    TableName: USERS_TABLE
  }));

  const items = result.Items || [];
  return items.map((u) => {
    const { password_hash, ...rest } = u;
    return rest;
  }).sort((a, b) => (b.id || 0) - (a.id || 0));
}

module.exports = {
  getUserById,
  listUsers
};
