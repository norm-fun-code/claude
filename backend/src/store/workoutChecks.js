// Per-exercise / non-negotiable workout checkmarks. Mirrors the check-in/habits
// model: each tap upserts one row keyed by (date, item), and the app rehydrates
// the day's checks on mount — so they survive tab switches and reset at midnight.
const { query } = require('../db');

/** Today's (or a given date's) checks as { itemKey: true } for done items. */
async function getChecks(date) {
  const { rows } = await query(
    `SELECT item_key, done FROM workout_checks WHERE check_date = $1`,
    [date]
  );
  const checks = {};
  for (const r of rows) if (r.done) checks[r.item_key] = true;
  return checks;
}

/** Upsert a single check (done true/false) for a date. */
async function setCheck({ date, itemKey, itemType = 'exercise', done = true }) {
  await query(
    `INSERT INTO workout_checks (check_date, item_key, item_type, done, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (check_date, item_key)
       DO UPDATE SET done = EXCLUDED.done, item_type = EXCLUDED.item_type, updated_at = now()`,
    [date, itemKey, itemType, done]
  );
}

module.exports = { getChecks, setCheck };
