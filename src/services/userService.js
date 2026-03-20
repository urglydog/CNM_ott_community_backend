const { pool } = require('../config/mysqlConfig');
const bcrypt = require('bcryptjs');

async function registerUser(payload) {
  const connection = await pool.getConnection();
  try {
    if (!payload.username || !payload.password) {
      throw new Error('Username and password are required');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(payload.password, salt);

    const [result] = await connection.execute(
      `INSERT INTO users (username, password_hash, email, display_name, status)
       VALUES (?, ?, ?, ?, 'offline')`,
      [
        payload.username,
        passwordHash,
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
      'SELECT id, username, password_hash, email, phone_number, display_name, avatar_url, status, created_at FROM users WHERE username = ?',
      [payload.username]
    );
    if (!rows.length) {
      throw new Error('User not found, please register');
    }

		if (!payload.password) {
			throw new Error('Password is required');
		}

		const userRow = rows[0];
		const passwordMatch = await bcrypt.compare(payload.password, userRow.password_hash);
		if (!passwordMatch) {
			throw new Error('Invalid username or password');
		}

		// loại bỏ password_hash trước khi trả về
		const { password_hash, ...userWithoutPassword } = userRow;
		return userWithoutPassword;
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
