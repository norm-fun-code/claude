// Persisted briefings/reviews (daily | weekly | quarterly narratives).
const { query } = require('../db');

async function saveBriefing({ kind = 'daily', content, periodStart = null, periodEnd = null }) {
  const { rows } = await query(
    `INSERT INTO briefings (kind, content, period_start, period_end)
     VALUES ($1, $2, $3, $4) RETURNING id, generated_at`,
    [kind, content, periodStart, periodEnd]
  );
  return rows[0] ?? null;
}

async function latestBriefing(kind = 'weekly') {
  const { rows } = await query(
    `SELECT * FROM briefings WHERE kind = $1 ORDER BY generated_at DESC LIMIT 1`,
    [kind]
  );
  return rows[0] ?? null;
}

module.exports = { saveBriefing, latestBriefing };
