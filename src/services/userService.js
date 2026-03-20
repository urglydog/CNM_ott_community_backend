const { ddbDocClient } = require('../config/awsConfig');
const { PutCommand, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const bcrypt = require('bcryptjs');

const USERS_TABLE = process.env.DDB_USERS_TABLE || 'ott_users';

async function registerUser(payload) {
  if (!payload.username || !payload.password) {
    throw new Error('Username and password are required');
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(payload.password, salt);

  const now = new Date().toISOString();
  // Dùng timestamp làm id đơn giản (giữ kiểu number giống MySQL cho frontend)
  const id = Date.now();
  const userId = String(id);

  const item = {
    userId, // primary key của bảng DynamoDB
    id,     // giữ id dạng number cho frontend & JWT nếu cần
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

  // Không có index trên username nên dùng Scan + Filter cho đơn giản
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

async function getUserById(userId) {
  if (!userId) return null;

  // Ưu tiên lấy theo khoá chính userId (string)
  const keyUserId = String(userId);
  const result = await ddbDocClient.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { userId: keyUserId }
  }));

  if (result.Item) {
    const { password_hash, ...userWithoutPassword } = result.Item;
    return userWithoutPassword;
  }

  // Fallback: nếu bảng cũ dùng "id" là khoá chính
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
  // Bỏ password_hash nếu có
  return items.map((u) => {
    const { password_hash, ...rest } = u;
    return rest;
  }).sort((a, b) => (b.id || 0) - (a.id || 0));
}

module.exports = {
  registerUser,
  loginUser,
  getUserById,
  listUsers
};
