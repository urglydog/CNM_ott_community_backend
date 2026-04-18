const { ddbDocClient } = require('../../config/awsConfig');
const { GetCommand, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const bcrypt = require('bcryptjs');

const USERS_TABLE = process.env.DDB_USERS_TABLE || 'ott_users';
const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 5 * 60 * 1000);
const EMAIL_PROVIDER = (process.env.OTP_EMAIL_PROVIDER || 'console').toLowerCase();
const SMS_PROVIDER = (process.env.OTP_SMS_PROVIDER || 'console').toLowerCase();
const INCLUDE_OTP_DEBUG = String(process.env.OTP_INCLUDE_IN_RESPONSE || '').toLowerCase() === 'true';

const otpStore = new Map();

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isValidPhone(phone) {
  return /^(0[3-9])[0-9]{8}$/.test(String(phone || '').trim());
}

function isStrongPassword(password) {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(String(password || ''));
}

function maskTarget(target) {
  const value = String(target || '');
  if (value.includes('@')) {
    const [name, domain] = value.split('@');
    const safeName = (name || '').slice(0, 2);
    return `${safeName}***@${domain || ''}`;
  }
  return value.length <= 4 ? '***' : `***${value.slice(-3)}`;
}

function otpKey(type, target) {
  return `${String(type)}:${String(target).trim().toLowerCase()}`;
}

function createOTP(type, target) {
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const key = otpKey(type, target);
  otpStore.set(key, {
    otp,
    expiresAt: Date.now() + OTP_TTL_MS,
  });
  return otp;
}

async function sendOtpEmail(email, otp) {
  if (EMAIL_PROVIDER === 'sendgrid') {
    const apiKey = process.env.SENDGRID_API_KEY;
    const fromEmail = process.env.SENDGRID_FROM_EMAIL;
    if (!apiKey || !fromEmail) {
      throw new Error('Thiếu cấu hình SENDGRID_API_KEY hoặc SENDGRID_FROM_EMAIL');
    }

    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: fromEmail },
        subject: 'Ma OTP xac thuc tai khoan',
        content: [{
          type: 'text/plain',
          value: `Ma OTP cua ban la: ${otp}. Ma co hieu luc trong ${Math.floor(OTP_TTL_MS / 60000)} phut.`,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gui OTP email that bai (${response.status}): ${text.substring(0, 200)}`);
    }
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[OTP][EMAIL][${EMAIL_PROVIDER}] ${email} => ${otp}`);
}

async function sendOtpSms(phone, otp) {
  if (SMS_PROVIDER === 'twilio') {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromPhone = process.env.TWILIO_FROM_PHONE;
    if (!accountSid || !authToken || !fromPhone) {
      throw new Error('Thiếu cấu hình Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_PHONE)');
    }

    const form = new URLSearchParams();
    form.append('From', fromPhone);
    form.append('To', phone);
    form.append('Body', `Ma OTP cua ban la ${otp}. Het han sau ${Math.floor(OTP_TTL_MS / 60000)} phut.`);

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gui OTP SMS that bai (${response.status}): ${text.substring(0, 200)}`);
    }
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[OTP][PHONE][${SMS_PROVIDER}] ${phone} => ${otp}`);
}

function verifyStoredOTP(type, target, otp) {
  const key = otpKey(type, target);
  const record = otpStore.get(key);
  if (!record) {
    throw new Error('Mã OTP không tồn tại hoặc đã hết hạn');
  }
  if (record.expiresAt < Date.now()) {
    otpStore.delete(key);
    throw new Error('Mã OTP đã hết hạn');
  }
  if (String(record.otp) !== String(otp || '')) {
    throw new Error('Mã OTP không đúng');
  }
  otpStore.delete(key);
}

async function findUserByIdentifier({ email, phone, username }) {
  const filterParts = [];
  const values = {};
  const names = {};

  if (email) {
    filterParts.push('#email = :email');
    names['#email'] = 'email';
    values[':email'] = String(email).trim();
  }
  if (phone) {
    filterParts.push('#phone = :phone');
    names['#phone'] = 'phone_number';
    values[':phone'] = String(phone).trim();
  }
  if (username) {
    filterParts.push('#username = :username');
    names['#username'] = 'username';
    values[':username'] = String(username).trim();
  }

  if (filterParts.length === 0) return null;

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: USERS_TABLE,
    FilterExpression: filterParts.join(' OR '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    Limit: 1,
  }));

  return result.Items && result.Items.length > 0 ? result.Items[0] : null;
}

async function resolveAuthUser(userId, username) {
  const byId = await getUserById(userId);
  if (byId) return byId;

  if (username) {
    const byUsername = await findUserByIdentifier({ username });
    if (byUsername) {
      const { password_hash, ...userWithoutPassword } = byUsername;
      return userWithoutPassword;
    }
  }

  return null;
}

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

async function updateProfile(userId, payload) {
  const user = await getUserById(userId);
  if (!user) {
    throw new Error('Không tìm thấy tài khoản');
  }

  const displayName = payload.displayName || payload.fullName || payload.display_name;
  const email = payload.email;
  const phone = payload.phone || payload.phoneNumber || payload.phone_number;
  const avatarUrl = payload.avatarUrl || payload.avatar_url;

  const updateParts = [];
  const names = {};
  const values = {};

  if (displayName !== undefined) {
    if (String(displayName).trim().length < 2 || String(displayName).trim().length > 50) {
      throw new Error('Họ tên phải từ 2-50 ký tự');
    }
    updateParts.push('#display_name = :display_name');
    names['#display_name'] = 'display_name';
    values[':display_name'] = String(displayName).trim();
  }

  if (email !== undefined) {
    if (String(email).trim() !== '' && !isValidEmail(email)) {
      throw new Error('Email không hợp lệ');
    }
    updateParts.push('#email = :email');
    names['#email'] = 'email';
    values[':email'] = String(email || '').trim() || null;
  }

  if (phone !== undefined) {
    if (!isValidPhone(phone)) {
      throw new Error('Số điện thoại không hợp lệ');
    }
    updateParts.push('#phone_number = :phone_number');
    names['#phone_number'] = 'phone_number';
    values[':phone_number'] = String(phone).trim();
  }

  if (avatarUrl !== undefined) {
    updateParts.push('#avatar_url = :avatar_url');
    names['#avatar_url'] = 'avatar_url';
    values[':avatar_url'] = String(avatarUrl || '').trim() || null;
  }

  if (updateParts.length === 0) {
    throw new Error('Không có dữ liệu cần cập nhật');
  }

  updateParts.push('#updated_at = :updated_at');
  names['#updated_at'] = 'updated_at';
  values[':updated_at'] = new Date().toISOString();

  await ddbDocClient.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { userId: String(user.userId || userId) },
    UpdateExpression: `SET ${updateParts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));

  return getUserById(user.userId || userId);
}

async function changePassword(userId, currentPassword, newPassword, username) {
  if (!currentPassword || !newPassword) {
    throw new Error('Thiếu mật khẩu hiện tại hoặc mật khẩu mới');
  }
  if (!isStrongPassword(newPassword)) {
    throw new Error('Mật khẩu mới phải có ít nhất 8 ký tự, gồm chữ hoa, chữ thường và số');
  }

  const user = await resolveAuthUser(userId, username);
  if (!user) {
    throw new Error('Không tìm thấy tài khoản');
  }

  let rawUser = null;
  const resolvedUserId = user.userId || userId || user.id;
  if (resolvedUserId) {
    const rawById = await ddbDocClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId: String(resolvedUserId) },
    }));
    rawUser = rawById.Item || null;
  }

  if (!rawUser && user.username) {
    rawUser = await findUserByIdentifier({ username: user.username });
  }

  if (!rawUser) {
    throw new Error('Không tìm thấy tài khoản');
  }

  const matched = await bcrypt.compare(String(currentPassword), String(rawUser.password_hash || ''));
  if (!matched) {
    throw new Error('Mật khẩu hiện tại không chính xác');
  }

  const newHash = await bcrypt.hash(String(newPassword), 10);

  await ddbDocClient.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { userId: String(rawUser.userId) },
    UpdateExpression: 'SET #password_hash = :password_hash, #updated_at = :updated_at',
    ExpressionAttributeNames: {
      '#password_hash': 'password_hash',
      '#updated_at': 'updated_at',
    },
    ExpressionAttributeValues: {
      ':password_hash': newHash,
      ':updated_at': new Date().toISOString(),
    },
  }));
}

async function sendEmailOTP(email) {
  if (!isValidEmail(email)) {
    throw new Error('Email không hợp lệ');
  }

  const targetEmail = String(email).trim().toLowerCase();
  const otp = createOTP('email', targetEmail);

  await sendOtpEmail(targetEmail, otp);

  const result = {
    message: `Đã gửi mã OTP đến email ${maskTarget(targetEmail)}`,
    expiresIn: Math.floor(OTP_TTL_MS / 1000),
  };
  if (INCLUDE_OTP_DEBUG) {
    result.debugOtp = otp;
  }
  return result;
}

async function verifyEmailOTP(email, otp) {
  if (!isValidEmail(email)) {
    throw new Error('Email không hợp lệ');
  }

  const targetEmail = String(email).trim().toLowerCase();
  verifyStoredOTP('email', targetEmail, otp);

  const found = await findUserByIdentifier({ email: targetEmail });
  if (found?.userId) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId: String(found.userId) },
      UpdateExpression: 'SET #email = :email, #email_verified = :email_verified, #updated_at = :updated_at',
      ExpressionAttributeNames: {
        '#email': 'email',
        '#email_verified': 'email_verified',
        '#updated_at': 'updated_at',
      },
      ExpressionAttributeValues: {
        ':email': targetEmail,
        ':email_verified': true,
        ':updated_at': new Date().toISOString(),
      },
    }));
  }
}

async function sendPhoneOTP(phone) {
  if (!isValidPhone(phone)) {
    throw new Error('Số điện thoại không hợp lệ');
  }

  const targetPhone = String(phone).trim();
  const otp = createOTP('phone', targetPhone);

  await sendOtpSms(targetPhone, otp);

  const result = {
    message: `Đã gửi mã OTP đến số điện thoại ${maskTarget(targetPhone)}`,
    expiresIn: Math.floor(OTP_TTL_MS / 1000),
  };
  if (INCLUDE_OTP_DEBUG) {
    result.debugOtp = otp;
  }
  return result;
}

async function verifyPhoneOTP(phone, otp) {
  if (!isValidPhone(phone)) {
    throw new Error('Số điện thoại không hợp lệ');
  }

  const targetPhone = String(phone).trim();
  verifyStoredOTP('phone', targetPhone, otp);

  const found = await findUserByIdentifier({ phone: targetPhone });
  if (found?.userId) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId: String(found.userId) },
      UpdateExpression: 'SET #phone_number = :phone_number, #phone_verified = :phone_verified, #updated_at = :updated_at',
      ExpressionAttributeNames: {
        '#phone_number': 'phone_number',
        '#phone_verified': 'phone_verified',
        '#updated_at': 'updated_at',
      },
      ExpressionAttributeValues: {
        ':phone_number': targetPhone,
        ':phone_verified': true,
        ':updated_at': new Date().toISOString(),
      },
    }));
  }
}

async function resetPassword({ identifier, otp, type, newPassword }) {
  const normalizedType = String(type || '').trim().toLowerCase();
  const trimmedIdentifier = String(identifier || '').trim();

  if (!trimmedIdentifier || !otp || !newPassword) {
    throw new Error('Thiếu dữ liệu đặt lại mật khẩu');
  }
  if (!['email', 'phone'].includes(normalizedType)) {
    throw new Error('Loại xác thực không hợp lệ');
  }
  if (!isStrongPassword(newPassword)) {
    throw new Error('Mật khẩu mới phải có ít nhất 8 ký tự, gồm chữ hoa, chữ thường và số');
  }

  if (normalizedType === 'email' && !isValidEmail(trimmedIdentifier)) {
    throw new Error('Email không hợp lệ');
  }
  if (normalizedType === 'phone' && !isValidPhone(trimmedIdentifier)) {
    throw new Error('Số điện thoại không hợp lệ');
  }

  verifyStoredOTP(normalizedType, normalizedType === 'email' ? trimmedIdentifier.toLowerCase() : trimmedIdentifier, otp);

  const rawUser = await findUserByIdentifier(
    normalizedType === 'email'
      ? { email: trimmedIdentifier.toLowerCase() }
      : { phone: trimmedIdentifier }
  );

  if (!rawUser?.userId) {
    throw new Error('Không tìm thấy tài khoản tương ứng');
  }

  const newHash = await bcrypt.hash(String(newPassword), 10);
  await ddbDocClient.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { userId: String(rawUser.userId) },
    UpdateExpression: 'SET #password_hash = :password_hash, #updated_at = :updated_at',
    ExpressionAttributeNames: {
      '#password_hash': 'password_hash',
      '#updated_at': 'updated_at',
    },
    ExpressionAttributeValues: {
      ':password_hash': newHash,
      ':updated_at': new Date().toISOString(),
    },
  }));
}

module.exports = {
  getUserById,
  listUsers,
  updateProfile,
  changePassword,
  sendEmailOTP,
  verifyEmailOTP,
  sendPhoneOTP,
  verifyPhoneOTP,
  resetPassword,
};
