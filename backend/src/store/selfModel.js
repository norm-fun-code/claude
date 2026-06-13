const { query } = require('../db');

async function saveModel({ content, snapshot = {}, kind = 'nightly' } = {}) {
  const { rows } = await query(
    `INSERT INTO self_model (kind, content, snapshot)
     VALUES ($1, $2, $3) RETURNING id, generated_at`,
    [kind, content, JSON.stringify(snapshot)]
  );
  return rows[0] ?? null;
}

async function latestModel() {
  const { rows } = await query(
    'SELECT * FROM self_model ORDER BY generated_at DESC LIMIT 1'
  );
  return rows[0] ?? null;
}

/** Just the content string — the fast path for injection into prompts. */
async function latestModelText() {
  const row = await latestModel();
  return row?.content ?? null;
}

module.exports = { saveModel, latestModel, latestModelText };
