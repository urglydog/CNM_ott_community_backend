const { pool } = require('../config/mysqlConfig');

// Ở schema MySQL, message có thể thuộc channel (group) hoặc direct_chat.
// Ở đây ta đơn giản hoá: conversationId dạng "channel:1" hoặc "direct:1".

function parseConversationId(conversationId) {
  if (!conversationId) return { mode: 'channel', id: null };
  if (conversationId.startsWith('channel:')) {
    return { mode: 'channel', id: Number(conversationId.replace('channel:', '')) };
  }
  if (conversationId.startsWith('direct:')) {
    return { mode: 'direct', id: Number(conversationId.replace('direct:', '')) };
  }
  // fallback: coi như channel_id
  return { mode: 'channel', id: Number(conversationId) };
}

async function saveMessage(payload) {
  const { mode, id } = parseConversationId(payload.conversationId);
  if (!id) {
    throw new Error('Invalid conversationId');
  }

  const connection = await pool.getConnection();
  try {
    const isChannel = mode === 'channel';

    const [result] = await connection.execute(
      `INSERT INTO messages (sender_id, channel_id, direct_chat_id, type, content, attachments, reactions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.senderId,
        isChannel ? id : null,
        isChannel ? null : id,
        payload.contentType || 'text',
        payload.content || '',
        payload.attachments ? JSON.stringify(payload.attachments) : null,
        payload.reactions ? JSON.stringify(payload.reactions) : null
      ]
    );

    const messageId = result.insertId;

    // Cập nhật last_message_id cho channel/direct_chat
    if (isChannel) {
      await connection.execute(
        'UPDATE channels SET last_message_id = ? WHERE id = ?',
        [messageId, id]
      );
    } else {
      await connection.execute(
        'UPDATE direct_chats SET last_message_id = ? WHERE id = ?',
        [messageId, id]
      );
    }

    const [rows] = await connection.execute(
      'SELECT * FROM messages WHERE id = ?',
      [messageId]
    );

    const msg = rows[0];
    return {
      id: msg.id,
      conversationId: payload.conversationId,
      senderId: msg.sender_id,
      contentType: msg.type,
      content: msg.content,
      attachments: msg.attachments ? JSON.parse(msg.attachments) : null,
      reactions: msg.reactions ? JSON.parse(msg.reactions) : null,
      createdAt: msg.created_at
    };
  } finally {
    connection.release();
  }
}

async function getMessagesForConversation(conversationId) {
  const { mode, id } = parseConversationId(conversationId);
  if (!id) return [];

  const connection = await pool.getConnection();
  try {
    const isChannel = mode === 'channel';
    const [rows] = await connection.execute(
      `SELECT * FROM messages
       WHERE ${isChannel ? 'channel_id' : 'direct_chat_id'} = ?
       ORDER BY created_at ASC`,
      [id]
    );

    return rows.map((msg) => ({
      id: msg.id,
      conversationId,
      senderId: msg.sender_id,
      contentType: msg.type,
      content: msg.content,
      attachments: msg.attachments ? JSON.parse(msg.attachments) : null,
      reactions: msg.reactions ? JSON.parse(msg.reactions) : null,
      createdAt: msg.created_at
    }));
  } finally {
    connection.release();
  }
}

module.exports = {
  saveMessage,
  getMessagesForConversation
};
