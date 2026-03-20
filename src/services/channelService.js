const { pool } = require('../config/mysqlConfig');

async function getChannelsByGroup(groupId) {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT id, group_id, name, type, last_message_id, created_at FROM channels WHERE group_id = ? ORDER BY id ASC',
      [groupId]
    );

    return rows.map((row) => ({
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      type: row.type,
      lastMessageId: row.last_message_id,
      createdAt: row.created_at
    }));
  } finally {
    connection.release();
  }
}

async function getChannelById(channelId) {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT id, group_id, name, type, last_message_id, created_at FROM channels WHERE id = ?',
      [channelId]
    );

    if (!rows.length) return null;
    const row = rows[0];

    return {
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      type: row.type,
      lastMessageId: row.last_message_id,
      createdAt: row.created_at
    };
  } finally {
    connection.release();
  }
}

module.exports = {
  getChannelsByGroup,
  getChannelById
};
