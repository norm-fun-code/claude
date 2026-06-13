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

async function saveMessage({ role, content, sources = [], embedding = null }) {
  if (role !== 'user' && role !== 'assistant') throw new Error('role must be user|assistant');
  const { rows } = await query(
    `INSERT INTO chat_messages (role, content, sources, embedding)
     VALUES ($1, $2, $3, $4::vector) RETURNING id, created_at`,
    [role, String(content ?? ''), JSON.stringify(sources), toVectorLiteral(embedding)]
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
};
