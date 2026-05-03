const { ddbDocClient } = require('../../config/awsConfig');
const { PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const bcrypt = require('bcryptjs');

const USERS_TABLE = process.env.DDB_USERS_TABLE || 'ott_users';

function normalizeUsername(input) {
  return String(input || '').trim().normalize('NFKC');
}

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

const USER_PHONE_SCAN_ATTRIBUTES = {
  '#userId': 'userId',
  '#phone_number': 'phone_number',
  '#username': 'username'
};

const USER_LOGIN_SCAN_ATTRIBUTES = {
  '#userId': 'userId',
  '#username': 'username',
  '#phone_number': 'phone_number',
  '#password_hash': 'password_hash'
};

const USER_LOGIN_PROFILE_SCAN_ATTRIBUTES = {
  '#userId': 'userId',
  '#username': 'username',
  '#phone_number': 'phone_number',
  '#password_hash': 'password_hash',
  '#email': 'email',
  '#display_name': 'display_name',
  '#avatar_url': 'avatar_url',
  '#email_verified': 'email_verified',
  '#phone_verified': 'phone_verified',
  '#status': 'status',
  '#created_at': 'created_at',
  '#updated_at': 'updated_at'
};

async function findUserByPhone(phoneNumber) {
  const normalizedInputPhone = normalizePhoneNumber(phoneNumber);
  if (!normalizedInputPhone) return null;

  let lastEvaluatedKey;
  do {
    const result = await ddbDocClient.send(new ScanCommand({
      TableName: USERS_TABLE,
      ProjectionExpression: '#userId, #phone_number, #username',
      ExpressionAttributeNames: USER_PHONE_SCAN_ATTRIBUTES,
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
  const normalizedInputUsername = normalizeUsername(username);
  if (!normalizedInputUsername) return null;

  let lastEvaluatedKey;
  const matches = [];
  do {
    const result = await ddbDocClient.send(new ScanCommand({
      TableName: USERS_TABLE,
      ProjectionExpression: '#userId, #username, #phone_number, #password_hash',
      ExpressionAttributeNames: USER_LOGIN_SCAN_ATTRIBUTES,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    const matched = (result.Items || []).find((item) =>
      normalizeUsername(item.username) === normalizedInputUsername
    );

    if (matched) matches.push(matched);
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return matches.length > 0 ? matches[0] : null;
}

async function findUsersByUsername(username) {
  const normalizedInputUsername = normalizeUsername(username);
  if (!normalizedInputUsername) return [];

  let lastEvaluatedKey;
  const matches = [];
  do {
    const result = await ddbDocClient.send(new ScanCommand({
      TableName: USERS_TABLE,
      ProjectionExpression: '#userId, #username, #phone_number, #password_hash, #email, #display_name, #avatar_url, #email_verified, #phone_verified, #status, #created_at, #updated_at',
      ExpressionAttributeNames: USER_LOGIN_PROFILE_SCAN_ATTRIBUTES,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    for (const item of result.Items || []) {
      if (normalizeUsername(item.username) === normalizedInputUsername) {
        matches.push(item);
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return matches;
}

async function registerUser(payload) {
  const normalizedUsername = normalizeUsername(payload.username);

  if (!normalizedUsername) {
    throw new Error('Vui lòng nhập tên đăng nhập');
  }
  if (!payload.password || !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/.test(payload.password)) {
    throw new Error('Mật khẩu phải có ít nhất 6 ký tự, bao gồm chữ hoa, chữ thường và số');
  }

  const normalizedPhoneNumber = normalizePhoneNumber(payload.phone || payload.phoneNumber || payload.phone_number);
  if (!normalizedPhoneNumber) {
    throw new Error('Vui lòng nhập số điện thoại');
  }
  if (!isValidPhoneNumber(normalizedPhoneNumber)) {
    throw new Error('Số điện thoại không hợp lệ (phải bắt đầu bằng 0 và đủ 10 số)');
  }

  // KIỂM TRA DUY NHẤT: Giống Zalo, 1 SĐT chỉ 1 tài khoản
  const existingPhone = await findUserByPhone(normalizedPhoneNumber);
  if (existingPhone) {
    throw new Error('Số điện thoại này đã được đăng ký, vui lòng đăng nhập hoặc dùng số khác');
  }

  const existingUsername = await findUserByUsername(normalizedUsername);
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
    username: normalizedUsername,
    password_hash: passwordHash,
    email: payload.email ? String(payload.email).trim() : null,
    phone_number: normalizedPhoneNumber,
    display_name: payload.display_name || payload.displayName || normalizedUsername,
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
  const identifier = String(payload.username || '').trim();

  if (!identifier) {
    throw new Error('Vui lòng nhập tên đăng nhập hoặc số điện thoại');
  }
  if (!payload.password) {
    throw new Error('Vui lòng nhập mật khẩu');
  }

  let userToAuth = null;

  // Thử tìm theo số điện thoại trước nếu chuỗi chứa toàn số
  if (/^\d+$/.test(identifier) && identifier.length >= 8) {
    userToAuth = await findUserByPhone(identifier);
    if (userToAuth) {
      // Re-fetch with password_hash because findUserByPhone projection might be limited
      const fullUserRes = await ddbDocClient.send(new ScanCommand({
        TableName: USERS_TABLE,
        FilterExpression: '#userId = :uid',
        ExpressionAttributeNames: { '#userId': 'userId' },
        ExpressionAttributeValues: { ':uid': userToAuth.userId }
      }));
      userToAuth = fullUserRes.Items?.[0] || null;
    }
  }

  // Nếu không tìm thấy theo SĐT, thử tìm theo username
  if (!userToAuth) {
    const matchingUsers = await findUsersByUsername(identifier);
    if (matchingUsers.length > 0) {
      userToAuth = matchingUsers[0];
    }
  }

  if (!userToAuth) {
    throw new Error('Không tìm thấy tài khoản, vui lòng đăng ký trước');
  }

  const passwordMatch = await bcrypt.compare(payload.password, userToAuth.password_hash);
  if (!passwordMatch) {
    throw new Error('Tên đăng nhập hoặc mật khẩu không đúng');
  }

  const { password_hash, ...userWithoutPassword } = userToAuth;
  return userWithoutPassword;
}

module.exports = {
  registerUser,
  loginUser
};
