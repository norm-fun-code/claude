// Life chapters — persistent long-arc facts (a pregnancy + due date, a big
// deadline) that inform every brief without being re-typed weekly. See
// intelligence/chapters.js for the derived, auto-advancing phrasing.
const { query } = require('../db');

async function listActive() {
  const { rows } = await query(
    `SELECT * FROM life_chapters WHERE active = true ORDER BY key_date ASC NULLS LAST, created_at ASC LIMIT 8`
  );
  return rows;
}

async function create({ kind = 'countdown', label, keyDate = null, keyDateLabel = null, notes = null }) {
  const { rows } = await query(
    `INSERT INTO life_chapters (kind, label, key_date, key_date_label, notes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [kind, label, keyDate, keyDateLabel, notes]
  );
  return rows[0];
}

async function deactivate(id) {
  const { rowCount } = await query(
    `UPDATE life_chapters SET active = false, updated_at = now() WHERE id = $1`,
    [id]
  );
  return rowCount > 0;
}

module.exports = { listActive, create, deactivate };
