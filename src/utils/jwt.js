const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key';
const JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || `${JWT_SECRET}_refresh_dev_only`;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

function signAccessToken(payload) {
  return jwt.sign(
    { ...payload, typ: 'access' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function signRefreshToken(payload) {
  return jwt.sign(
    { ...payload, typ: 'refresh' },
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES_IN }
  );
}

/** Access token — dùng cho Authorization: Bearer */
function verifyAccessToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (decoded.typ && decoded.typ !== 'access') {
    const err = new Error('Invalid token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return decoded;
}

function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, JWT_REFRESH_SECRET);
  if (decoded.typ !== 'refresh') {
    const err = new Error('Invalid refresh token');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return decoded;
}

const signToken = signAccessToken;
const verifyToken = verifyAccessToken;

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  signToken,
  verifyToken
};
