// Life chapters — persistent long-arc facts (a pregnancy + due date, a big
// deadline) that inform every brief without being re-typed weekly. See
// intelligence/chapters.js for the derived, auto-advancing phrasing.
const { query } = require('../db');

async function listActive(db = query) {
  const { rows } = await db(
    `SELECT * FROM life_chapters WHERE active = true ORDER BY key_date ASC NULLS LAST, created_at ASC LIMIT 8`
  );
  return rows;
}

async function create({ kind = 'countdown', label, keyDate = null, keyDateLabel = null, notes = null }, db = query) {
  const { rows } = await db(
    `INSERT INTO life_chapters (kind, label, key_date, key_date_label, notes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [kind, label, keyDate, keyDateLabel, notes]
  );
  return rows[0];
}

/**
 * Create-or-correct: "Nancy is due January 2, not January 6" must UPDATE the
 * standing fact, not add a second pregnancy. A new chapter replaces any active
 * one it clearly refers to — same kind for a pregnancy (there's one at a time),
 * same normalized label otherwise — by deactivating the old row first.
 * Returns { chapter, replaced } so callers can phrase "updated" vs "remembered".
 */
async function createOrReplace(input, db = query) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const existing = await listActive(db);
  const matches = existing.filter((ch) =>
    input.kind === 'pregnancy' ? ch.kind === 'pregnancy' : norm(ch.label) === norm(input.label)
  );
  for (const ch of matches) await deactivate(ch.id, db);
  const chapter = await create(input, db);
  return { chapter, replaced: matches.length > 0 };
}

async function deactivate(id, db = query) {
  const { rowCount } = await db(
    `UPDATE life_chapters SET active = false, updated_at = now() WHERE id = $1`,
    [id]
  );
  return rowCount > 0;
}

module.exports = { listActive, create, createOrReplace, deactivate };
