const { pool } = require('../config/mysqlConfig');

async function createGroup(payload) {
  const connection = await pool.getConnection();
  try {
    const [result] = await connection.execute(
      `INSERT INTO groups (name, description, type, created_by)
       VALUES (?, ?, ?, ?)` ,
      [
        payload.name,
        payload.description || '',
        payload.type || 'public_community',
        payload.ownerId || payload.createdBy || null
      ]
    );

    const groupId = result.insertId;

    if (payload.ownerId) {
      await connection.execute(
        `INSERT INTO group_members (group_id, user_id, role)
         VALUES (?, ?, 'owner')`,
        [groupId, payload.ownerId]
      );
    }

    const [rows] = await connection.execute(
      'SELECT id, name, description, avatar_url, type, join_setting, member_count, created_by, created_at FROM groups WHERE id = ?',
      [groupId]
    );
    return rows[0];
  } finally {
    connection.release();
  }
}

async function listGroups() {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT id, name, description, avatar_url, type AS topic, member_count, created_by, created_at FROM groups ORDER BY id DESC'
    );

    return rows.map((g) => ({
      groupId: g.id,
      name: g.name,
      description: g.description,
      topic: g.topic,
      avatarUrl: g.avatar_url,
      memberCount: g.member_count,
      createdBy: g.created_by,
      createdAt: g.created_at
    }));
  } finally {
    connection.release();
  }
}

async function getGroupById(groupId) {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT id, name, description, avatar_url, type AS topic, member_count, created_by, created_at FROM groups WHERE id = ?',
      [groupId]
    );
    if (!rows.length) return null;
    const g = rows[0];
    return {
      groupId: g.id,
      name: g.name,
      description: g.description,
      topic: g.topic,
      avatarUrl: g.avatar_url,
      memberCount: g.member_count,
      createdBy: g.created_by,
      createdAt: g.created_at
    };
  } finally {
    connection.release();
  }
}

async function addMemberToGroup(groupId, userId, role = 'member') {
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role)`,
      [groupId, userId, role]
    );

    return { groupId, userId, role };
  } finally {
    connection.release();
  }
}

async function getGroupsForUser(userId) {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      `SELECT g.id, g.name, g.description, g.avatar_url, g.type AS topic, g.member_count, g.created_by, g.created_at
       FROM group_members gm
       JOIN groups g ON gm.group_id = g.id
       WHERE gm.user_id = ?`,
      [userId]
    );

    return rows.map((g) => ({
      groupId: g.id,
      name: g.name,
      description: g.description,
      topic: g.topic,
      avatarUrl: g.avatar_url,
      memberCount: g.member_count,
      createdBy: g.created_by,
      createdAt: g.created_at
    }));
  } finally {
    connection.release();
  }
}

module.exports = {
  createGroup,
  listGroups,
  getGroupById,
  addMemberToGroup,
  getGroupsForUser
};
