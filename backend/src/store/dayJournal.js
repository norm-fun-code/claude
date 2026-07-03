// Daily context journal store — free-text "what happened and why" per day.
const { query } = require('../db');

async function create({ text, entryDate, source = 'voice' }) {
  const t = String(text || '').trim();
  if (!t) throw new Error('day journal text required');
  const { rows } = await query(
    `INSERT INTO day_journal (entry_date, text, source)
     VALUES ($1, $2, $3) RETURNING *`,
    [entryDate, t.slice(0, 4000), source]
  );
  return rows[0] ?? null;
}

/**
 * Recent entries, newest first, with entry_date as a plain YYYY-MM-DD string
 * (to_char, not the JS Date node-postgres returns for ::date columns). Used to
 * ground the Ask brain and the nightly self-model in the last stretch of days.
 */
async function recent({ days = 7, limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, text, source, created_at
       FROM day_journal
      WHERE entry_date >= (current_date - ($1::int - 1))
      ORDER BY created_at DESC
      LIMIT $2`,
    [days, limit]
  );
  return rows;
}

/** All of one day's entries (oldest first), for the evening brief's "today" read. */
async function forDay(dateStr) {
  const { rows } = await query(
    `SELECT text, created_at FROM day_journal
      WHERE entry_date = $1::date ORDER BY created_at ASC`,
    [dateStr]
  );
  return rows;
}

module.exports = { create, recent, forDay };
