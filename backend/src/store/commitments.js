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

async function create({ title, detail = null, source = 'voice', dueAt = null, metricKey = null, recommendationId = null }) {
  const t = String(title || '').trim();
  if (!t) throw new Error('commitment title required');
  const { rows } = await query(
    `INSERT INTO commitments (title, detail, source, due_at, metric_key, recommendation_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [t.slice(0, 200), detail ? String(detail).slice(0, 500) : null, source, dueAt, metricKey, recommendationId]
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

/**
 * If this commitment was auto-created from a metric-less recommendation
 * (recommendation_id set), close the loop by writing an adherence outcome —
 * the same ±1 delta convention the manual thumbs-up/down endpoint already
 * uses for recs with no expected_direction. Never let this fail the caller's
 * markDone/markSkipped.
 */
function recordAdherenceOutcome(row, delta) {
  if (!row?.recommendation_id) return;
  require('./recommendations')
    .setOutcome(row.recommendation_id, { delta, measuredAt: row.completed_at ?? new Date() })
    .catch((e) => console.error('[commitments] adherence outcome failed:', e.message));
}

async function markDone(id, { at = new Date() } = {}) {
  const { rows } = await query(
    `UPDATE commitments SET status = 'done', completed_at = $2
      WHERE id = $1 AND status <> 'done' RETURNING *`,
    [id, at]
  );
  const row = rows[0] ?? null;
  if (row) recordAdherenceOutcome(row, 1);
  return row;
}

async function markSkipped(id) {
  const { rows } = await query(
    `UPDATE commitments SET status = 'skipped' WHERE id = $1 AND status = 'open' RETURNING *`,
    [id]
  );
  const row = rows[0] ?? null;
  if (row) recordAdherenceOutcome(row, -1);
  return row;
}

/**
 * Pure: is this commitment due for a (re)nudge right now? Handles both the FIRST
 * reminder and follow-ups — a still-open commitment keeps getting nudged every
 * `reNudgeMs` until it's done/skipped, capped by `maxReminders` total and a
 * `maxAgeMs` cutoff so it eventually gives up instead of nagging forever.
 */
function isReminderDue(c, { now, reNudgeMs, maxReminders, maxAgeMs }) {
  if (!c || c.status !== 'open' || !c.due_at) return false;
  const due = new Date(c.due_at).getTime();
  if (Number.isNaN(due) || due > now) return false;         // not due yet
  if (due <= now - maxAgeMs) return false;                  // too old — stop nudging
  if ((c.reminder_count ?? 0) >= maxReminders) return false; // hit the per-commitment cap
  if (c.reminded_at == null) return true;                   // never nudged → first reminder
  return new Date(c.reminded_at).getTime() <= now - reNudgeMs; // enough time since last nudge
}

/**
 * Open, due commitments that should be (re)nudged now. Fetches the small set of
 * open+due rows and filters with the pure rule above, so both the first reminder
 * and later follow-ups flow through one testable decision.
 */
async function dueForReminder({ now = new Date(), reNudgeHours = 3, maxReminders = 4, maxAgeHours = 24 } = {}) {
  const { rows } = await query(
    `SELECT * FROM commitments
      WHERE status = 'open' AND due_at IS NOT NULL AND due_at <= $1
      ORDER BY due_at ASC`,
    [now]
  );
  const opts = {
    now: now.getTime(),
    reNudgeMs: reNudgeHours * 60 * 60 * 1000,
    maxReminders,
    maxAgeMs: maxAgeHours * 60 * 60 * 1000,
  };
  return rows.filter((c) => isReminderDue(c, opts));
}

async function markReminded(id, { at = new Date() } = {}) {
  await query(`UPDATE commitments SET reminded_at = $2, reminder_count = reminder_count + 1 WHERE id = $1`, [id, at]);
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

/** Expire open, timed commitments whose due time passed by more than `staleHours`.
 *  24h by default so an afternoon commitment survives the overnight quiet window
 *  and can still re-nudge the next morning before it's finally abandoned. */
async function expireStale({ now = new Date(), staleHours = 24 } = {}) {
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
  isReminderDue,
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
