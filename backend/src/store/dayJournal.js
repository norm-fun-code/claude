// Daily context journal store — free-text "what happened and why" per day.
const { query } = require('../db');

// node-postgres returns a bare ::date column as a JS Date with no timezone
// context, not a string — the exact bug that made habit-streak dots never fill
// in earlier this session. Every read of entry_date below goes through
// to_char() instead of relying on the driver's default parsing.
async function create({ text, entryDate, source = 'voice' }) {
  const t = String(text || '').trim();
  if (!t) throw new Error('day journal text required');
  const { rows } = await query(
    `INSERT INTO day_journal (entry_date, text, source)
     VALUES ($1, $2, $3)
     RETURNING id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, text, source, created_at`,
    [entryDate, t.slice(0, 4000), source]
  );
  return rows[0] ?? null;
}

/**
 * Recent entries, newest first. Used to ground the Ask brain and the nightly
 * self-model in the last stretch of days. The window boundary is computed in
 * the CALLER's local day (tz), not the DB session's default (typically UTC) —
 * bare `current_date` would drift a day off during the evening hours where
 * UTC has already rolled to tomorrow but the user's local day hasn't.
 */
async function recent({ days = 7, limit = 20, tz = process.env.TZ || 'America/New_York' } = {}) {
  const { rows } = await query(
    `SELECT id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, text, source, created_at
       FROM day_journal
      WHERE entry_date >= ((now() AT TIME ZONE $1)::date - ($2::int - 1))
      ORDER BY created_at DESC
      LIMIT $3`,
    [tz, days, limit]
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
