const { pool } = require('../config/mysqlConfig');

async function registerUser(payload) {
  const connection = await pool.getConnection();
  try {
    const [result] = await connection.execute(
      `INSERT INTO users (username, password_hash, email, display_name, status)
       VALUES (?, ?, ?, ?, 'offline')`,
      [
        payload.username,
        payload.passwordHash || 'hashed_pw_demo',
        payload.email || `${payload.username}@example.com`,
        payload.displayName || payload.username
      ]
    );

    const insertedId = result.insertId;
    const [rows] = await connection.execute(
      'SELECT id, username, email, phone_number, display_name, avatar_url, status, created_at FROM users WHERE id = ?',
      [insertedId]
    );
    return rows[0];
  } finally {
    connection.release();
  }
}

async function loginUser(payload) {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT id, username, email, phone_number, display_name, avatar_url, status, created_at FROM users WHERE username = ?',
      [payload.username]
    );
    if (!rows.length) {
      throw new Error('User not found, please register');
    }
    return rows[0];
  } finally {
    connection.release();
  }
}

async function getUserById(userId) {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT id, username, email, phone_number, display_name, avatar_url, status, created_at FROM users WHERE id = ?',
      [userId]
    );
    return rows[0] || null;
  } finally {
    connection.release();
  }
}

async function listUsers() {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT id, username, email, phone_number, display_name, avatar_url, status, created_at FROM users ORDER BY id DESC'
    );
    return rows;
  } finally {
    connection.release();
  }
}

module.exports = {
  registerUser,
  loginUser,
  getUserById,
  listUsers
};
