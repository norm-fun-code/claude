// Persistent chat memory store. Two layers:
//   1. Recent tail — the last N turns, loaded back as live conversation context
//      so a thread survives app restarts ("tell me more about that").
//   2. Long-term recall — each user question is embedded, so a NEW question can
//      semantically retrieve RELEVANT PAST conversations from any point in
//      history ("last time you asked about X, here's what we concluded").
const { query } = require('../db');

function toVectorLiteral(embedding) {
  if (!embedding || !Array.isArray(embedding)) return null;
  return `[${embedding.join(',')}]`;
}

/** A short title from the first user message ("Why was my focus low?" → as-is). */
function deriveTitle(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New conversation';
  return t.length > 42 ? `${t.slice(0, 42).trimEnd()}…` : t;
}

/** The one live thread's id, creating it if none exists. Survives the unique
 *  one-active index by re-reading on a conflict. */
async function ensureActiveConversation() {
  const { rows } = await query(`SELECT id FROM conversations WHERE is_active LIMIT 1`);
  if (rows[0]) return rows[0].id;
  try {
    const { rows: ins } = await query(`INSERT INTO conversations (is_active) VALUES (true) RETURNING id`);
    return ins[0].id;
  } catch {
    const { rows: again } = await query(`SELECT id FROM conversations WHERE is_active LIMIT 1`);
    return again[0]?.id ?? null;
  }
}

async function saveMessage({ role, content, sources = [], embedding = null, conversationId = null }) {
  if (role !== 'user' && role !== 'assistant') throw new Error('role must be user|assistant');
  const convId = conversationId ?? (await ensureActiveConversation());
  const { rows } = await query(
    `INSERT INTO chat_messages (role, content, sources, embedding, conversation_id)
     VALUES ($1, $2, $3, $4::vector, $5) RETURNING id, created_at`,
    [role, String(content ?? ''), JSON.stringify(sources), toVectorLiteral(embedding), convId]
  );
  // Touch the thread, and auto-title it from the first user message.
  await query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [convId]);
  if (role === 'user') {
    await query(
      `UPDATE conversations SET title = $2 WHERE id = $1 AND (title IS NULL OR title = '')`,
      [convId, deriveTitle(content)]
    );
  }
  return rows[0] ?? null;
}

/** Most recent `limit` turns OF THE ACTIVE THREAD, oldest-first, for prompt
 *  context. Empty when there's no active thread (a fresh start). */
async function recentMessages({ limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT role, content, sources, created_at
       FROM (
         SELECT m.role, m.content, m.sources, m.created_at, m.id
           FROM chat_messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.is_active
          ORDER BY m.created_at DESC, m.id DESC LIMIT $1
       ) t
      ORDER BY created_at ASC, id ASC`,
    [limit]
  );
  return rows;
}

/** Archive the active thread: title it, stamp saved_at, deactivate. The next
 *  message lazily starts a fresh active thread. No-op if it has no messages. */
async function saveActiveConversation({ title = null } = {}) {
  const { rows } = await query(`SELECT id FROM conversations WHERE is_active LIMIT 1`);
  if (!rows[0]) return null;
  const id = rows[0].id;
  const { rows: cnt } = await query(`SELECT count(*)::int AS n FROM chat_messages WHERE conversation_id = $1`, [id]);
  if (!cnt[0].n) return null; // nothing worth saving
  await query(
    `UPDATE conversations
        SET saved_at = now(), is_active = false,
            title = COALESCE(NULLIF(title, ''), $2)
      WHERE id = $1`,
    [id, title || 'Saved conversation']
  );
  const { rows: out } = await query(`SELECT * FROM conversations WHERE id = $1`, [id]);
  return out[0];
}

/** Saved threads for the sidebar, newest-saved first, with a preview + count. */
async function listConversations() {
  const { rows } = await query(
    `SELECT c.id, c.title, c.created_at, c.updated_at, c.saved_at, c.is_active,
            count(m.id)::int AS message_count,
            (SELECT content FROM chat_messages
              WHERE conversation_id = c.id AND role = 'user'
              ORDER BY id ASC LIMIT 1) AS first_message
       FROM conversations c
       LEFT JOIN chat_messages m ON m.conversation_id = c.id
      WHERE c.saved_at IS NOT NULL
      GROUP BY c.id
      ORDER BY c.saved_at DESC`
  );
  return rows;
}

/** All messages of a thread, oldest-first. */
async function conversationMessages(id) {
  const { rows } = await query(
    `SELECT role, content, sources, created_at FROM chat_messages
      WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`,
    [id]
  );
  return rows;
}

/** Resume a saved thread: make it the live one. Returns its messages. */
async function openConversation(id) {
  await query(`UPDATE conversations SET is_active = false WHERE is_active`);
  await query(`UPDATE conversations SET is_active = true, updated_at = now() WHERE id = $1`, [id]);
  return conversationMessages(id);
}

/** Delete a thread and its messages (sidebar trash). */
async function deleteConversation(id) {
  const { rowCount } = await query(`DELETE FROM conversations WHERE id = $1`, [id]);
  return rowCount;
}

/** Discard the active thread without saving (the "Clear" action). */
async function clearActiveConversation() {
  const { rows } = await query(`SELECT id FROM conversations WHERE is_active LIMIT 1`);
  if (!rows[0]) return 0;
  const { rowCount } = await query(`DELETE FROM conversations WHERE id = $1`, [rows[0].id]);
  return rowCount;
}

/**
 * Long-term recall: the past user questions most similar to `embedding`, each
 * paired with the assistant answer that immediately followed it. Excludes the
 * most recent `excludeRecentTurns` rows (those already arrive as the live tail,
 * so we don't want to double-count them) and anything below `minSimilarity`
 * (cosine), so only genuinely-related past threads are surfaced. Returns
 * [{ question, answer, createdAt, similarity }] strongest-first.
 */
async function searchSimilarTurns(embedding, { k = 3, excludeRecentTurns = 20, minSimilarity = 0.72 } = {}) {
  const vec = toVectorLiteral(embedding);
  if (!vec) return [];
  const { rows } = await query(
    `WITH recent AS (
       SELECT id FROM chat_messages ORDER BY created_at DESC, id DESC LIMIT $3
     ),
     candidates AS (
       SELECT id, content, created_at,
              1 - (embedding <=> $1::vector) AS similarity
         FROM chat_messages
        WHERE role = 'user' AND embedding IS NOT NULL
          AND id NOT IN (SELECT id FROM recent)
        ORDER BY embedding <=> $1::vector
        LIMIT $2
     )
     SELECT c.content AS question, c.created_at, c.similarity, a.content AS answer
       FROM candidates c
       LEFT JOIN LATERAL (
         SELECT content FROM chat_messages
          WHERE role = 'assistant' AND id > c.id
          ORDER BY id ASC LIMIT 1
       ) a ON true
      WHERE c.similarity >= $4
      ORDER BY c.similarity DESC`,
    [vec, k, excludeRecentTurns, minSimilarity]
  );
  return rows.map((r) => ({
    question: r.question,
    answer: r.answer ?? '',
    createdAt: r.created_at,
    similarity: Number(r.similarity),
  }));
}

/** User-question rows that still lack an embedding (for one-time backfill). */
async function unembeddedQuestions({ limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT id, content FROM chat_messages
      WHERE role = 'user' AND embedding IS NULL
      ORDER BY id ASC LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Set the embedding for a previously-saved message (backfill). */
async function setEmbedding(id, embedding) {
  const vec = toVectorLiteral(embedding);
  if (!vec) return false;
  await query('UPDATE chat_messages SET embedding = $2::vector WHERE id = $1', [id, vec]);
  return true;
}

/** Wipe the conversation (the in-app "start fresh" / clear-history action). */
async function clearMessages() {
  const { rowCount } = await query('DELETE FROM chat_messages');
  return rowCount;
}

module.exports = {
  saveMessage,
  recentMessages,
  searchSimilarTurns,
  unembeddedQuestions,
  setEmbedding,
  clearMessages,
  ensureActiveConversation,
  saveActiveConversation,
  listConversations,
  conversationMessages,
  openConversation,
  deleteConversation,
  clearActiveConversation,
};
