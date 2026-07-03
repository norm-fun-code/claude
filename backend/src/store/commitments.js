// Commitments store — the follow-through ledger. A commitment is something the
// user said they'd do, optionally with a due time, tracked from creation →
// on-time nudge → done/skipped, and graded that evening.
const { query } = require('../db');

/**
 * Resolve the model/user-supplied "when" string into a concrete due time. Pure.
 * The server runs with TZ set to the user's zone, so a naive local ISO string
 * ("2026-07-04T14:00") parses as their wall-clock time — no timezone library
 * needed. Anything unparseable, empty, or already in the past becomes an
 * UNTIMED commitment (dueAt: null) — it still shows on Today, it just never
 * fires an instant or stale push. The model is given the current time, so a
 * well-formed request lands in the future; this only guards mistakes.
 *
 * @param {string|null} atStr
 * @param {Date} [now]
 * @returns {{ dueAt: Date|null }}
 */
function resolveReminderTime(atStr, now = new Date()) {
  if (!atStr || typeof atStr !== 'string') return { dueAt: null };
  const parsed = new Date(atStr.trim());
  if (Number.isNaN(parsed.getTime())) return { dueAt: null };
  // 2-minute grace so "remind me now / in a moment" doesn't get dropped as past.
  if (parsed.getTime() <= now.getTime() - 2 * 60 * 1000) return { dueAt: null };
  // Sanity ceiling: no reminders more than a year out (a fat-fingered year, etc.).
  if (parsed.getTime() > now.getTime() + 366 * 24 * 60 * 60 * 1000) return { dueAt: null };
  return { dueAt: parsed };
}

async function create({ title, detail = null, source = 'voice', dueAt = null, metricKey = null }) {
  const t = String(title || '').trim();
  if (!t) throw new Error('commitment title required');
  const { rows } = await query(
    `INSERT INTO commitments (title, detail, source, due_at, metric_key)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [t.slice(0, 200), detail ? String(detail).slice(0, 500) : null, source, dueAt, metricKey]
  );
  return rows[0] ?? null;
}

/** Open commitments, soonest-due first (untimed last), newest tie-break. For the card. */
async function listActive({ limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT * FROM commitments
      WHERE status = 'open'
      ORDER BY due_at ASC NULLS LAST, created_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Today's commitments grouped by status — for the evening day-close grade.
 * "Today" = due today OR (untimed and created today), in the given tz.
 */
async function todaySummary(tz = 'America/New_York') {
  const { rows } = await query(
    `SELECT id, title, status, due_at, completed_at
       FROM commitments
      WHERE (due_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
         OR (due_at IS NULL AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date)
      ORDER BY due_at ASC NULLS LAST`,
    [tz]
  );
  const summary = { open: [], done: [], skipped: [], expired: [] };
  for (const r of rows) (summary[r.status] || (summary[r.status] = [])).push(r);
  return summary;
}

async function markDone(id, { at = new Date() } = {}) {
  const { rows } = await query(
    `UPDATE commitments SET status = 'done', completed_at = $2
      WHERE id = $1 AND status <> 'done' RETURNING *`,
    [id, at]
  );
  return rows[0] ?? null;
}

async function markSkipped(id) {
  const { rows } = await query(
    `UPDATE commitments SET status = 'skipped' WHERE id = $1 AND status = 'open' RETURNING *`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Open commitments that have come due and haven't been reminded yet. Bounded by
 * a grace window so a commitment that came due hours ago (while the poller was
 * down, or that the user simply blew past) isn't nudged uselessly late — it just
 * ages out to the evening grade / expiry instead.
 */
async function dueForReminder({ now = new Date(), graceHours = 3 } = {}) {
  const graceStart = new Date(now.getTime() - graceHours * 60 * 60 * 1000);
  const { rows } = await query(
    `SELECT * FROM commitments
      WHERE status = 'open' AND reminded_at IS NULL
        AND due_at IS NOT NULL AND due_at <= $1 AND due_at > $2
      ORDER BY due_at ASC`,
    [now, graceStart]
  );
  return rows;
}

async function markReminded(id, { at = new Date() } = {}) {
  await query(`UPDATE commitments SET reminded_at = $2 WHERE id = $1`, [id, at]);
}

/** How many commitment reminders have fired today (tz) — for the daily cap. */
async function remindersSentToday(tz = 'America/New_York') {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM commitments
      WHERE reminded_at IS NOT NULL
        AND (reminded_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [tz]
  );
  return rows[0]?.n ?? 0;
}

/** Expire open, timed commitments whose due time passed by more than `staleHours`. */
async function expireStale({ now = new Date(), staleHours = 12 } = {}) {
  const cutoff = new Date(now.getTime() - staleHours * 60 * 60 * 1000);
  const { rowCount } = await query(
    `UPDATE commitments SET status = 'expired'
      WHERE status = 'open' AND due_at IS NOT NULL AND due_at < $1`,
    [cutoff]
  );
  return rowCount;
}

module.exports = {
  resolveReminderTime,
  create,
  listActive,
  todaySummary,
  markDone,
  markSkipped,
  dueForReminder,
  markReminded,
  remindersSentToday,
  expireStale,
};
