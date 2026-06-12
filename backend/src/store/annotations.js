// Life-context annotations: travel, illness, deadlines, etc. — so the
// intelligence layer (and you) can explain anomalies instead of being misled.
const { query } = require('../db');

const ET_TZ = 'America/New_York';

/** End-of-calendar-day (23:59:59) for TOMORROW in server local time
 *  (TZ=America/New_York on Railway). Annotations default to this so they're
 *  active all of today AND tomorrow morning — covering the next-day briefing
 *  that explains metrics affected by last night (e.g. low sleep after a late
 *  Knicks game). They're gone the day after that. */
function endOfTomorrowET(d = new Date()) {
  const eod = new Date(d);
  eod.setDate(eod.getDate() + 1);
  eod.setHours(23, 59, 59, 0);
  return eod;
}

async function createAnnotation(a) {
  const { startTs, endTs = null, category, label, note = null } = a;
  // Default end_ts to end-of-day ET so annotations expire automatically.
  // Callers can pass an explicit endTs for multi-day events (e.g. travel).
  const resolvedEndTs = endTs ?? endOfTomorrowET(new Date(startTs));
  const { rows } = await query(
    `INSERT INTO annotations (start_ts, end_ts, category, label, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [startTs, resolvedEndTs, category, label, note]
  );
  return rows[0]?.id ?? null;
}

async function listAnnotations({ from = null, to = null, limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT * FROM annotations
      WHERE ($1::timestamptz IS NULL OR start_ts >= $1)
        AND ($2::timestamptz IS NULL OR start_ts <= $2)
      ORDER BY start_ts DESC
      LIMIT $3`,
    [from, to, limit]
  );
  return rows;
}

/** Annotations overlapping a window — used to contextualize findings. */
async function overlapping(windowStart, windowEnd) {
  const { rows } = await query(
    `SELECT * FROM annotations
      WHERE start_ts <= $2
        AND COALESCE(end_ts, start_ts) >= $1
      ORDER BY start_ts DESC`,
    [windowStart, windowEnd]
  );
  return rows;
}

module.exports = { createAnnotation, listAnnotations, overlapping };
