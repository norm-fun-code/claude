// Persistent chat memory store. Append each turn; load the recent tail back as
// conversation history so chat continuity survives app restarts.
const { query } = require('../db');

async function saveMessage({ role, content, sources = [] }) {
  if (role !== 'user' && role !== 'assistant') throw new Error('role must be user|assistant');
  const { rows } = await query(
    `INSERT INTO chat_messages (role, content, sources)
     VALUES ($1, $2, $3) RETURNING id, created_at`,
    [role, String(content ?? ''), JSON.stringify(sources)]
  );
  return rows[0] ?? null;
}

/** Most recent `limit` turns, returned in chronological (oldest-first) order so
 *  they can be fed straight into the prompt as history. */
async function recentMessages({ limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT role, content, sources, created_at
       FROM (
         SELECT * FROM chat_messages ORDER BY created_at DESC, id DESC LIMIT $1
       ) t
      ORDER BY created_at ASC, id ASC`,
    [limit]
  );
  return rows;
}

/** Wipe the conversation (the in-app "start fresh" / clear-history action). */
async function clearMessages() {
  const { rowCount } = await query('DELETE FROM chat_messages');
  return rowCount;
}

module.exports = { saveMessage, recentMessages, clearMessages };
