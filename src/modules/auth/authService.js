const { ddbDocClient } = require('../../config/awsConfig');
const { PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const bcrypt = require('bcryptjs');

const USERS_TABLE = process.env.DDB_USERS_TABLE || 'ott_users';

async function registerUser(payload) {
  if (!payload.username || !payload.password) {
    throw new Error('Username and password are required');
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(payload.password, salt);

  const now = new Date().toISOString();
  const id = Date.now();
  const userId = String(id);

  const item = {
    userId,
    id,
    username: payload.username,
    password_hash: passwordHash,
    email: payload.email || `${payload.username}@example.com`,
    phone_number: payload.phoneNumber || null,
    display_name: payload.displayName || payload.username,
    avatar_url: null,
    status: 'offline',
    created_at: now
  };

  await ddbDocClient.send(new PutCommand({
    TableName: USERS_TABLE,
    Item: item
  }));

  const { password_hash, ...userWithoutPassword } = item;
  return userWithoutPassword;
}

async function loginUser(payload) {
  if (!payload.username) {
    throw new Error('Username is required');
  }
  if (!payload.password) {
    throw new Error('Password is required');
  }

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: USERS_TABLE,
    FilterExpression: '#username = :u',
    ExpressionAttributeNames: { '#username': 'username' },
    ExpressionAttributeValues: { ':u': payload.username }
  }));

  if (!result.Items || result.Items.length === 0) {
    throw new Error('User not found, please register');
  }

  const userRow = result.Items[0];
  const passwordMatch = await bcrypt.compare(payload.password, userRow.password_hash);
  if (!passwordMatch) {
    throw new Error('Invalid username or password');
  }

  const { password_hash, ...userWithoutPassword } = userRow;
  return userWithoutPassword;
}

module.exports = {
  registerUser,
  loginUser
};
