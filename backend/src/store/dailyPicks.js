// Day-locked content picks. get-or-create: the first call of the day for a given
// `kind` computes and stores the pick; later calls return the same payload until
// midnight (user's timezone). Used to make the Wisdom highlight set static for
// the day, like the Notion page and daily quote.
const { query } = require('../db');

/** Local calendar date (YYYY-MM-DD) for the configured timezone. */
function localDate(tz = process.env.TZ || 'America/New_York') {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * Return today's stored payload for `kind`, or null if none yet.
 */
async function get(kind) {
  const { rows } = await query(
    `SELECT payload FROM daily_picks WHERE kind = $1 AND pick_date = $2`,
    [kind, localDate()]
  );
  return rows[0]?.payload ?? null;
}

/**
 * Store today's payload for `kind` (idempotent: if a concurrent request already
 * wrote one, keep the existing pick and return it).
 */
async function set(kind, payload) {
  const { rows } = await query(
    `INSERT INTO daily_picks (kind, pick_date, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (kind, pick_date) DO UPDATE SET kind = daily_picks.kind
     RETURNING payload`,
    [kind, localDate(), JSON.stringify(payload)]
  );
  return rows[0]?.payload ?? payload;
}

/** Force-replace today's pick (used by an explicit "new set" refresh). */
async function replace(kind, payload) {
  const { rows } = await query(
    `INSERT INTO daily_picks (kind, pick_date, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (kind, pick_date) DO UPDATE SET payload = EXCLUDED.payload, created_at = now()
     RETURNING payload`,
    [kind, localDate(), JSON.stringify(payload)]
  );
  return rows[0]?.payload ?? payload;
}

module.exports = { get, set, replace, localDate };
