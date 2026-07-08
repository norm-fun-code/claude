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

async function listAnnotations({ from = null, to = null, limit = 100, category = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM annotations
      WHERE ($1::timestamptz IS NULL OR start_ts >= $1)
        AND ($2::timestamptz IS NULL OR start_ts <= $2)
        AND ($4::text IS NULL OR category = $4)
      ORDER BY start_ts DESC
      LIMIT $3`,
    [from, to, limit, category]
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

/**
 * Pure: build the `SET ... WHERE id = ...` clause + positional params for a
 * partial annotation edit, from whichever of {label, category} were actually
 * provided (undefined = "not sent, leave as-is" — distinct from an empty
 * string, which is rejected by the caller as an attempt to blank the label).
 * Split out so the SQL-building logic is unit-testable without a live DB.
 */
function buildAnnotationUpdate({ label, category, id }) {
  const sets = [];
  const params = [];
  if (label != null) { params.push(label.trim()); sets.push(`label = $${params.length}`); }
  if (category != null) { params.push(category); sets.push(`category = $${params.length}`); }
  if (!sets.length) return null; // nothing to update
  params.push(id);
  return { sql: `UPDATE annotations SET ${sets.join(', ')} WHERE id = $${params.length}`, params };
}

/** Edit an existing annotation's label and/or category IN PLACE (same row —
 *  every downstream reader queries annotations live, so a correction is
 *  visible on the very next read). Returns false if there was nothing to update. */
async function updateAnnotation(id, { label, category } = {}) {
  const built = buildAnnotationUpdate({ label, category, id });
  if (!built) return false;
  await query(built.sql, built.params);
  return true;
}

module.exports = { createAnnotation, listAnnotations, overlapping, buildAnnotationUpdate, updateAnnotation };
