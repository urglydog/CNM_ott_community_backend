const { randomUUID } = require('crypto');
const { ddbDocClient } = require('../../config/awsConfig');
const { GetCommand, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const bcrypt = require('bcryptjs');

const USERS_TABLE = process.env.DDB_USERS_TABLE || 'ott_users';
const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 5 * 60 * 1000);
const OTP_SEND_COOLDOWN_MS = Number(process.env.OTP_SEND_COOLDOWN_MS || 60 * 1000);
const OTP_SEND_WINDOW_MS = Number(process.env.OTP_SEND_WINDOW_MS || 10 * 60 * 1000);
const OTP_SEND_MAX_PER_WINDOW = Number(process.env.OTP_SEND_MAX_PER_WINDOW || 3);
const PASSWORD_RECOVERY_TTL_MS = Number(process.env.PASSWORD_RECOVERY_TTL_MS || 10 * 60 * 1000);
const OTP_APP_NAME = process.env.OTP_APP_NAME || 'OTT Community';
const EMAIL_PROVIDER = (process.env.OTP_EMAIL_PROVIDER || 'console').trim().toLowerCase();
const SMS_PROVIDER = (process.env.OTP_SMS_PROVIDER || 'console').trim().toLowerCase();
const INCLUDE_OTP_DEBUG = String(process.env.OTP_INCLUDE_IN_RESPONSE || '').toLowerCase() === 'true';

const otpStore = new Map();
const otpSendStore = new Map();
const recoveryStore = new Map();

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isValidPhone(phone) {
  return /^(0[3-9])[0-9]{8}$/.test(String(phone || '').trim());
}

function isValidUsername(username) {
  return /^[a-zA-Z0-9_]{3,30}$/.test(String(username || '').trim());
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

function normalizeEmailValue(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhoneValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length === 11) {
    return `0${digits.slice(2)}`;
  }
  if (digits.startsWith('0')) {
    return digits;
  }
  if (digits.length === 9 && /^[3-9]/.test(digits)) {
    return `0${digits}`;
  }
  return raw;
}

function getOtpMinutes() {
  return Math.max(1, Math.ceil(OTP_TTL_MS / 60000));
}

function normalizePhoneForTwilio(phone) {
  const raw = String(phone || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();

  const compact = raw.replace(/\s+/g, '');

  if (compact.startsWith('+')) {
    const digits = compact.slice(1).replace(/\D/g, '');
    return digits ? `+${digits}` : compact;
  }

  const digits = compact.replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length === 11) {
    return `+${digits}`;
  }
  if (/^0[3-9][0-9]{8}$/.test(digits)) {
    return `+84${digits.slice(1)}`;
  }
  if (/^[3-9][0-9]{8}$/.test(digits)) {
    return `+84${digits}`;
  }

  return compact;
}

function otpKey(type, target) {
  return `${String(type)}:${String(target).trim().toLowerCase()}`;
}

function createOTP(type, target) {
  const key = otpKey(type, target);
  const existing = otpStore.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.otp;
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(key, {
    otp,
    expiresAt: Date.now() + OTP_TTL_MS,
  });
  return otp;
}

function getOtpSendRecord(type, target) {
  const key = otpKey(type, target);
  const now = Date.now();
  const existing = otpSendStore.get(key);
  if (!existing) {
    return { key, record: null, now };
  }

  const recentAttempts = (existing.attempts || []).filter((timestamp) => now - timestamp < OTP_SEND_WINDOW_MS);
  if (recentAttempts.length === 0) {
    otpSendStore.delete(key);
    return { key, record: null, now };
  }

  const record = {
    ...existing,
    attempts: recentAttempts,
  };
  otpSendStore.set(key, record);
  return { key, record, now };
}

function assertOtpSendAllowed(type, target) {
  const { key, record, now } = getOtpSendRecord(type, target);
  if (!record) {
    return;
  }

  const lastAttemptAt = record.attempts[record.attempts.length - 1];
  const cooldownRemaining = OTP_SEND_COOLDOWN_MS - (now - lastAttemptAt);
  if (cooldownRemaining > 0) {
    throw new Error(`Vui lòng đợi ${Math.ceil(cooldownRemaining / 1000)} giây trước khi gửi lại mã OTP`);
  }

  if (record.attempts.length >= OTP_SEND_MAX_PER_WINDOW) {
    const windowRemaining = OTP_SEND_WINDOW_MS - (now - record.attempts[0]);
    throw new Error(`Bạn đã gửi OTP quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(windowRemaining / 1000)} giây`);
  }

  otpSendStore.set(key, record);
}

function recordOtpSendAttempt(type, target) {
  const key = otpKey(type, target);
  const now = Date.now();
  const existing = otpSendStore.get(key);
  const attempts = existing?.attempts || [];
  const recentAttempts = attempts.filter((timestamp) => now - timestamp < OTP_SEND_WINDOW_MS);
  recentAttempts.push(now);

  otpSendStore.set(key, {
    attempts: recentAttempts,
    lastSentAt: now,
  });
}

function getRecoverySession(token) {
  const recoveryToken = String(token || '').trim();
  if (!recoveryToken) return null;

  const session = recoveryStore.get(recoveryToken);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    recoveryStore.delete(recoveryToken);
    return null;
  }

  return session;
}

function saveRecoverySession(session) {
  recoveryStore.set(session.token, session);
}

async function sendPasswordRecoveryOTP(identifier) {
  const trimmedIdentifier = String(identifier || '').trim();
  if (!trimmedIdentifier) {
    throw new Error('Vui lòng nhập email hoặc số điện thoại');
  }

  const isPhoneIdentifier = isValidPhone(trimmedIdentifier);
  const isEmailIdentifier = isValidEmail(trimmedIdentifier);

  if (!isPhoneIdentifier && !isEmailIdentifier) {
    throw new Error('Email hoặc số điện thoại không hợp lệ');
  }

  const user = await findUserByIdentifier(
    isPhoneIdentifier
      ? { phone: trimmedIdentifier }
      : { email: trimmedIdentifier.toLowerCase() }
  );

  if (!user?.userId) {
    throw new Error('Không tìm thấy tài khoản tương ứng');
  }

  let channel = 'phone';
  let target = normalizePhoneValue(user.phone_number || trimmedIdentifier);

  if (isPhoneIdentifier) {
    if (!isValidPhone(target)) {
      throw new Error('Số điện thoại không hợp lệ');
    }
  } else {
    const normalizedEmail = normalizeEmailValue(user.email || trimmedIdentifier);
    if (!isValidEmail(normalizedEmail)) {
      throw new Error('Email không hợp lệ');
    }
    channel = 'email';
    target = normalizedEmail;
  }

  assertOtpSendAllowed(channel, target);

  if (channel === 'email') {
    await sendOtpEmail(target, createOTP('email', target));
  } else {
    await sendOtpSms(target, createOTP('phone', target));
  }

  recordOtpSendAttempt(channel, target);

  const token = randomUUID();
  const now = Date.now();
  saveRecoverySession({
    token,
    userId: String(user.userId),
    identifier: trimmedIdentifier,
    identifierType: isPhoneIdentifier ? 'phone' : 'username',
    channel,
    target,
    verifiedAt: null,
    createdAt: now,
    expiresAt: now + PASSWORD_RECOVERY_TTL_MS,
  });

  return {
    recoveryToken: token,
    channel,
    target: maskTarget(target),
    expiresIn: Math.floor(PASSWORD_RECOVERY_TTL_MS / 1000),
  };
}

async function verifyPasswordRecoveryOTP(recoveryToken, otp) {
  const session = getRecoverySession(recoveryToken);
  if (!session) {
    throw new Error('Phiên xác thực đã hết hạn hoặc không tồn tại');
  }

  verifyStoredOTP(session.channel, session.target, otp);

  if (session.channel === 'email' && isValidEmail(session.target)) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId: String(session.userId) },
      UpdateExpression: 'SET #email_verified = :email_verified, #updated_at = :updated_at',
      ExpressionAttributeNames: {
        '#email_verified': 'email_verified',
        '#updated_at': 'updated_at',
      },
      ExpressionAttributeValues: {
        ':email_verified': true,
        ':updated_at': new Date().toISOString(),
      },
    }));
  }

  if (session.channel === 'phone' && isValidPhone(session.target)) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId: String(session.userId) },
      UpdateExpression: 'SET #phone_verified = :phone_verified, #updated_at = :updated_at',
      ExpressionAttributeNames: {
        '#phone_verified': 'phone_verified',
        '#updated_at': 'updated_at',
      },
      ExpressionAttributeValues: {
        ':phone_verified': true,
        ':updated_at': new Date().toISOString(),
      },
    }));
  }

  saveRecoverySession({
    ...session,
    verifiedAt: Date.now(),
  });
}

async function resetPasswordWithRecovery(recoveryToken, newPassword) {
  const session = getRecoverySession(recoveryToken);
  if (!session) {
    throw new Error('Phiên đặt lại mật khẩu đã hết hạn hoặc không tồn tại');
  }

  if (!session.verifiedAt) {
    throw new Error('Vui lòng xác thực OTP trước khi đặt lại mật khẩu');
  }

  if (!isStrongPassword(newPassword)) {
    throw new Error('Mật khẩu mới phải có ít nhất 8 ký tự, gồm chữ hoa, chữ thường và số');
  }

  const newHash = await bcrypt.hash(String(newPassword), 10);
  await ddbDocClient.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { userId: String(session.userId) },
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

  recoveryStore.delete(session.token);
}

async function sendOtpEmail(email, otp) {
  const otpMinutes = getOtpMinutes();
  const subject = `${OTP_APP_NAME} - Mã OTP xác thực tài khoản`;
  const message = `Xin chào,\n\nMã OTP của bạn là: ${otp}\nMã có hiệu lực trong ${otpMinutes} phút.\n\nNếu bạn không yêu cầu mã này, hãy bỏ qua email này.`;

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
        subject,
        content: [{
          type: 'text/plain',
          value: message,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gui OTP email that bai (${response.status}): ${text.substring(0, 200)}`);
    }
    return;
  }

  if (EMAIL_PROVIDER === 'resend') {
    const apiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL;
    if (!apiKey || !fromEmail) {
      throw new Error('Thiếu cấu hình Resend (RESEND_API_KEY, RESEND_FROM_EMAIL)');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject,
        text: message,
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
  const otpMinutes = getOtpMinutes();
  const message = `${OTP_APP_NAME}: ma OTP cua ban la ${otp}. Hieu luc trong ${otpMinutes} phut. Neu ban khong yeu cau, hay bo qua tin nhan nay.`;

  if (SMS_PROVIDER !== 'twilio') {
    // eslint-disable-next-line no-console
    console.log(`[OTP][PHONE][console] ${phone} => ${otp}`);
    return;
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = normalizePhoneForTwilio(process.env.TWILIO_FROM_PHONE);
  if (!accountSid || !authToken || !fromPhone) {
    throw new Error('Thiếu cấu hình Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_PHONE)');
  }
  const sid = String(accountSid).trim();
  if (!sid.startsWith('AC')) {
    throw new Error('TWILIO_ACCOUNT_SID không hợp lệ. Phải dùng Account SID bắt đầu bằng AC, không dùng API Key bắt đầu bằng SK.');
  }
  if (!/^AC[a-zA-Z0-9]{32}$/.test(sid)) {
    throw new Error('TWILIO_ACCOUNT_SID sai định dạng. Vui lòng kiểm tra lại giá trị Account SID trên Twilio Console.');
  }

  const targetPhone = normalizePhoneForTwilio(phone);
  if (!/^\+[1-9][0-9]{7,14}$/.test(targetPhone)) {
    throw new Error('Số điện thoại nhận SMS phải có định dạng quốc tế để gửi qua Twilio');
  }
  if (!/^\+[1-9][0-9]{7,14}$/.test(fromPhone)) {
    throw new Error('TWILIO_FROM_PHONE không hợp lệ, cần định dạng E.164 ví dụ +19893345542');
  }

  // Log chẩn đoán để đối chiếu chính xác số gửi/nhận với Twilio Verified Caller IDs.
  // eslint-disable-next-line no-console
  console.log(`[OTP][TWILIO] FROM: ${fromPhone} TO: ${targetPhone}`);
  // eslint-disable-next-line no-console
  console.log(`[OTP][TWILIO] USING SID: ${sid}`);

  const form = new URLSearchParams();
  form.append('From', fromPhone);
  form.append('To', targetPhone);
  form.append('Body', message);

  const auth = Buffer.from(`${sid}:${authToken}`).toString('base64');
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
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
    if (response.status === 400 && text.includes('21612')) {
      throw new Error('Twilio trial chỉ gửi SMS tới số điện thoại đã được xác minh trong tài khoản Twilio. Hãy verify số nhận trong Twilio Console.');
    }
    throw new Error(`Gui OTP SMS that bai (${response.status}): ${text.substring(0, 200)}`);
  }

  return;
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
  const result = await ddbDocClient.send(new ScanCommand({
    TableName: USERS_TABLE,
  }));

  const targetEmail = email ? normalizeEmailValue(email) : null;
  const targetPhone = phone ? normalizePhoneValue(phone) : null;
  const targetUsername = username ? String(username).trim() : null;

  const matched = (result.Items || []).find((item) => {
    const itemEmail = normalizeEmailValue(item.email);
    const itemPhone = normalizePhoneValue(item.phone_number);
    const itemUsername = String(item.username || '').trim();

    return (
      (targetEmail && itemEmail === targetEmail) ||
      (targetPhone && itemPhone === targetPhone) ||
      (targetUsername && itemUsername === targetUsername)
    );
  });

  return matched || null;
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
  const coverImage = payload.coverImage || payload.cover_url;

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
    updateParts.push('#email_verified = :email_verified');
    names['#email_verified'] = 'email_verified';
    values[':email_verified'] = false;
  }

  if (phone !== undefined) {
    if (!isValidPhone(phone)) {
      throw new Error('Số điện thoại không hợp lệ');
    }
    updateParts.push('#phone_number = :phone_number');
    names['#phone_number'] = 'phone_number';
    values[':phone_number'] = String(phone).trim();
    updateParts.push('#phone_verified = :phone_verified');
    names['#phone_verified'] = 'phone_verified';
    values[':phone_verified'] = false;
  }

  if (avatarUrl !== undefined) {
    updateParts.push('#avatar_url = :avatar_url');
    names['#avatar_url'] = 'avatar_url';
    values[':avatar_url'] = String(avatarUrl || '').trim() || null;
  }

  if (coverImage !== undefined) {
    updateParts.push('#coverImage = :coverImage');
    names['#coverImage'] = 'coverImage';
    values[':coverImage'] = String(coverImage || '').trim() || null;
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
  assertOtpSendAllowed('email', targetEmail);
  const otp = createOTP('email', targetEmail);

  await sendOtpEmail(targetEmail, otp);
  recordOtpSendAttempt('email', targetEmail);

  const result = {
    message: `Đã gửi mã OTP xác thực của ${OTP_APP_NAME} đến email ${maskTarget(targetEmail)}.`,
    channel: 'email',
    target: maskTarget(targetEmail),
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
  assertOtpSendAllowed('phone', targetPhone);
  const otp = createOTP('phone', targetPhone);

  await sendOtpSms(targetPhone, otp);
  recordOtpSendAttempt('phone', targetPhone);

  const result = {
    message: `Đã gửi mã OTP xác thực của ${OTP_APP_NAME} đến số điện thoại ${maskTarget(targetPhone)}.`,
    channel: 'phone',
    target: maskTarget(targetPhone),
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
  sendPasswordRecoveryOTP,
  verifyPasswordRecoveryOTP,
  resetPasswordWithRecovery,
  sendEmailOTP,
  verifyEmailOTP,
  sendPhoneOTP,
  verifyPhoneOTP,
  resetPassword,
};
