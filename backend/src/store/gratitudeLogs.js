// Free-text daily gratitude reflection backing the gratitude habit. One row per
// calendar day — re-saving the same day upserts rather than accumulating rows.
// `recent()` feeds the evening wind-down brief so what you wrote gets reflected
// back instead of being write-only.
const { query } = require('../db');

async function getByDate(logDate) {
  const { rows } = await query(`SELECT * FROM gratitude_logs WHERE log_date = $1`, [logDate]);
  return rows[0] ?? null;
}

async function upsert({ logDate, text }) {
  const { rows } = await query(
    `INSERT INTO gratitude_logs (log_date, text)
     VALUES ($1, $2)
     ON CONFLICT (log_date) DO UPDATE
       SET text = EXCLUDED.text, updated_at = now()
     RETURNING *`,
    [logDate, text]
  );
  return rows[0];
}

// Most recent entries, newest first, for the evening reflection. Excludes empty
// rows defensively (text is NOT NULL, but guards against whitespace-only saves).
//
// Wealth/evening hardening pass: this used to be `recent(days=5)` with NO date
// boundary at all — "5 most recent" meant the 5 most recent rows EVER, however
// old. If nothing had been logged in months, a months-old entry got presented
// in tonight's "presence beat" reflection with no indication it wasn't from
// today (notify/evening-brief.js's prompt frames it as "recent gratitude
// notes" and asks the model to echo it back as if fresh). `sinceYmd` is now
// REQUIRED — the caller passes its own canonical local "today" minus a lookback
// window (evening-brief.js), so a genuine gap in logging correctly produces NO
// rows (the brief's existing "no gratitude notes" path) instead of resurrecting
// old text.
async function recent(limit = 5, { sinceYmd } = {}) {
  if (!sinceYmd) throw new Error('gratitudeLogs.recent requires sinceYmd (the canonical local lookback boundary)');
  const { rows } = await query(
    `SELECT log_date, text FROM gratitude_logs
     WHERE btrim(text) <> ''
       AND log_date >= $2::date
     ORDER BY log_date DESC
     LIMIT $1`,
    [limit, sinceYmd]
  );
  return rows;
}

module.exports = { getByDate, upsert, recent };
