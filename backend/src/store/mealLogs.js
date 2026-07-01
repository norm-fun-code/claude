// Free-text daily meal/drink log backing the "not sure how to rate today?"
// Eating Healthy helper. One row per calendar day — re-scoring the same day
// upserts rather than accumulating duplicate rows.
const { query } = require('../db');

async function getByDate(logDate) {
  const { rows } = await query(`SELECT * FROM meal_logs WHERE log_date = $1`, [logDate]);
  return rows[0] ?? null;
}

async function upsert({ logDate, text, score = null, rationale = null }) {
  const { rows } = await query(
    `INSERT INTO meal_logs (log_date, text, score, rationale)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (log_date) DO UPDATE
       SET text = EXCLUDED.text, score = EXCLUDED.score, rationale = EXCLUDED.rationale, updated_at = now()
     RETURNING *`,
    [logDate, text, score, rationale]
  );
  return rows[0];
}

module.exports = { getByDate, upsert };
