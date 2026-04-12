'use strict';

// File token từ GitHub chính thức ZEGOCLOUD
// Không cần build gì thêm, chỉ copy và dùng
// Link: https://github.com/ZEGOCLOUD/zego_server_assistant

const crypto = require('crypto');

// Error codes
const ErrorCode = {
  success: 0,
  appIDInvalid: 1,
  userIDInvalid: 3,
  secretInvalid: 5,
  effectiveTimeInSecondsInvalid: 6
};

function RndNum(a, b) {
  return Math.ceil((a + (b - a)) * Math.random());
}

function makeRandomIv() {
  const str = '0123456789abcdefghijklmnopqrstuvwxyz';
  const result = [];
  for (let i = 0; i < 16; i++) {
    const r = Math.floor(Math.random() * str.length);
    result.push(str.charAt(r));
  }
  return result.join('');
}

function getAlgorithm(keyBase64) {
  const key = Buffer.from(keyBase64, 'utf8');
  switch (key.length) {
    case 16:
      return 'aes-128-cbc';
    case 24:
      return 'aes-192-cbc';
    case 32:
      return 'aes-256-cbc';
    default:
      throw new Error('Invalid key length: ' + key.length);
  }
}

function aesEncrypt(plainText, key, iv) {
  const cipher = crypto.createCipheriv(getAlgorithm(key), Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  cipher.setAutoPadding(true);
  const encrypted = cipher.update(plainText, 'utf8');
  const final = cipher.final();
  return Buffer.concat([encrypted, final]);
}

function generateToken04(appId, userId, secret, effectiveTimeInSeconds, payload) {
  // Validate inputs
  if (!appId || typeof appId !== 'number') {
    throw {
      errorCode: ErrorCode.appIDInvalid,
      errorMessage: 'appID invalid'
    };
  }

  if (!userId || typeof userId !== 'string') {
    throw {
      errorCode: ErrorCode.userIDInvalid,
      errorMessage: 'userId invalid'
    };
  }

  if (!secret || typeof secret !== 'string' || secret.length !== 32) {
    throw {
      errorCode: ErrorCode.secretInvalid,
      errorMessage: 'secret must be a 32 byte string'
    };
  }

  if (!effectiveTimeInSeconds || typeof effectiveTimeInSeconds !== 'number') {
    throw {
      errorCode: ErrorCode.effectiveTimeInSecondsInvalid,
      errorMessage: 'effectiveTimeInSeconds invalid'
    };
  }

  const createTime = Math.floor(new Date().getTime() / 1000);
  const tokenInfo = {
    app_id: appId,
    user_id: userId,
    nonce: RndNum(-2147483648, 2147483647),
    ctime: createTime,
    expire: createTime + effectiveTimeInSeconds,
    payload: payload || ''
  };

  const plaintText = JSON.stringify(tokenInfo);
  const iv = makeRandomIv();
  const encryptBuf = aesEncrypt(plaintText, secret, iv);

  const b1 = Buffer.alloc(8);
  b1.writeBigInt64BE(BigInt(tokenInfo.expire));

  const b2 = Buffer.alloc(2);
  b2.writeUInt16BE(iv.length);

  const b3 = Buffer.alloc(2);
  b3.writeUInt16BE(encryptBuf.length);

  const buf = Buffer.concat([
    b1,
    b2,
    Buffer.from(iv),
    b3,
    encryptBuf,
  ]);

  return '04' + buf.toString('base64');
}

module.exports = {
  generateToken04
};
