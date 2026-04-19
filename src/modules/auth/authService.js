const { ddbDocClient } = require('../../config/awsConfig');
const { PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const bcrypt = require('bcryptjs');

const USERS_TABLE = process.env.DDB_USERS_TABLE || 'ott_users';

function normalizePhoneNumber(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  let digits = raw.replace(/\D/g, '');

  // +84xxxxxxxxx / 84xxxxxxxxx -> 0xxxxxxxxx
  if (digits.startsWith('84') && digits.length === 11) {
    digits = `0${digits.slice(2)}`;
  }

  // 9-digit local without leading 0 -> add 0
  if (digits.length === 9 && /^[3-9]/.test(digits)) {
    digits = `0${digits}`;
  }

  return digits;
}

function isValidPhoneNumber(phoneNumber) {
  return /^(0[3-9])[0-9]{8}$/.test(String(phoneNumber || ''));
}

async function findUserByPhone(phoneNumber) {
  const normalizedInputPhone = normalizePhoneNumber(phoneNumber);
  if (!normalizedInputPhone) return null;

  let lastEvaluatedKey;
  do {
    const result = await ddbDocClient.send(new ScanCommand({
      TableName: USERS_TABLE,
      ProjectionExpression: 'userId, phone_number, username',
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    const matched = (result.Items || []).find((item) =>
      normalizePhoneNumber(item.phone_number) === normalizedInputPhone
    );

    if (matched) return matched;
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return null;
}

async function findUserByUsername(username) {
  if (!username) return null;

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: USERS_TABLE,
    FilterExpression: '#username = :username',
    ExpressionAttributeNames: { '#username': 'username' },
    ExpressionAttributeValues: { ':username': String(username).trim() },
    Limit: 1,
  }));

  return result.Items && result.Items.length > 0 ? result.Items[0] : null;
}

async function registerUser(payload) {
  if (!payload.username || !payload.password) {
    throw new Error('Vui lòng nhập tên đăng nhập và mật khẩu');
  }

  const normalizedPhoneNumber = normalizePhoneNumber(payload.phoneNumber || payload.phone);
  if (!normalizedPhoneNumber) {
    throw new Error('Vui lòng nhập số điện thoại');
  }
  if (!isValidPhoneNumber(normalizedPhoneNumber)) {
    throw new Error('Số điện thoại không hợp lệ');
  }

  const existingPhone = await findUserByPhone(normalizedPhoneNumber);
  if (existingPhone) {
    throw new Error('Số điện thoại đã được đăng ký');
  }

  const existingUsername = await findUserByUsername(payload.username);
  if (existingUsername) {
    throw new Error('Tên đăng nhập đã tồn tại');
  }

  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.email).trim())) {
    throw new Error('Email không hợp lệ');
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(payload.password, salt);

  const now = new Date().toISOString();
  const id = Date.now();
  const userId = String(id);

  const item = {
    userId,
    id,
    username: String(payload.username).trim(),
    password_hash: passwordHash,
    email: payload.email ? String(payload.email).trim() : null,
    phone_number: normalizedPhoneNumber,
    display_name: payload.displayName || payload.username,
    avatar_url: null,
    email_verified: false,
    phone_verified: false,
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
    throw new Error('Vui lòng nhập tên đăng nhập');
  }
  if (!payload.password) {
    throw new Error('Vui lòng nhập mật khẩu');
  }

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: USERS_TABLE,
    FilterExpression: '#username = :u',
    ExpressionAttributeNames: { '#username': 'username' },
    ExpressionAttributeValues: { ':u': payload.username }
  }));

  if (!result.Items || result.Items.length === 0) {
    throw new Error('Không tìm thấy tài khoản, vui lòng đăng ký trước');
  }

  const userRow = result.Items[0];
  const passwordMatch = await bcrypt.compare(payload.password, userRow.password_hash);
  if (!passwordMatch) {
    throw new Error('Tên đăng nhập hoặc mật khẩu không đúng');
  }

  const { password_hash, ...userWithoutPassword } = userRow;
  return userWithoutPassword;
}

module.exports = {
  registerUser,
  loginUser
};
