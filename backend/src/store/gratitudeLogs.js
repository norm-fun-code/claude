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
async function recent(days = 5) {
  const { rows } = await query(
    `SELECT log_date, text FROM gratitude_logs
     WHERE btrim(text) <> ''
     ORDER BY log_date DESC
     LIMIT $1`,
    [days]
  );
  return rows;
}

module.exports = { getByDate, upsert, recent };
