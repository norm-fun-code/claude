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

const TITLE_MAX = 100;

/**
 * A concise, deterministic title for a commitment derived from a longer
 * source action (THE ACTION card's full 1-2 sentence paragraph from the
 * morning brief) — no LLM call. Prefers the first sentence, since the
 * actionable instruction is almost always stated first ("Do the Zone 2 walk
 * today. It offsets yesterday's late Push session." → "Do the Zone 2 walk
 * today."); falls back to a word-boundary truncation when the first sentence
 * itself is still too long, or there's no sentence break at all. Pure and
 * exported so it's directly testable — the full original text is preserved
 * separately, in `detail`, never dropped.
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string}
 */
function deriveActionTitle(text, maxLen = TITLE_MAX) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.length <= maxLen) return t;
  const sentenceMatch = t.match(/^[^.!?]*[.!?]/);
  const firstSentence = sentenceMatch ? sentenceMatch[0].trim() : null;
  if (firstSentence && firstSentence.length <= maxLen) return firstSentence;
  const candidate = firstSentence || t;
  const cut = candidate.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.trim()}…`;
}

// Idempotency window for exact-title repeats: a voice/chat tool call that
// genuinely double-fires (a realtime session re-processing the same audio
// turn, a dropped-response client retry) produces the identical title text
// seconds apart — not a fuzzy paraphrase, an exact repeat. Catching only the
// exact-match case is zero-risk (it can never drop a legitimately different
// commitment, including a quick correction like "actually make that 10:45"),
// unlike a fuzzy-similarity guard would be.
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

async function create({ title, detail = null, source = 'voice', dueAt = null, metricKey = null, recommendationId = null }) {
  const t = String(title || '').trim();
  if (!t) throw new Error('commitment title required');
  const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS);
  const { rows: dupes } = await query(
    `SELECT * FROM commitments
      WHERE status = 'open' AND source = $1 AND lower(title) = lower($2) AND created_at >= $3
      ORDER BY created_at DESC LIMIT 1`,
    [source, t.slice(0, 200), cutoff]
  );
  if (dupes[0]) return dupes[0];
  const { rows } = await query(
    `INSERT INTO commitments (title, detail, source, due_at, metric_key, recommendation_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [t.slice(0, 200), detail ? String(detail).slice(0, 500) : null, source, dueAt, metricKey, recommendationId]
  );
  if (rows[0]) await invalidateCommitments();
  return rows[0] ?? null;
}

// A commitment create/complete/skip changes what the brief's completion language
// may claim — route it through the ONE invalidation bus (registry: COMMITMENT_CHANGE).
// Durable and awaited (not fire-and-forget): the caller is about to confirm this
// write as saved/done to the user (Transactional Brain Invalidation, audit
// recommendation #2, item 5).
async function invalidateCommitments() {
  try { await require('../brain/invalidation').bumpDurable('commitment_change'); } catch { /* bus not loaded */ }
}

// How far back a 'done' commitment is even considered as a completion-
// correction target — bounded deliberately (not a full-table scan): a
// correction naming something completed days ago is vanishingly unlikely,
// and every candidate row here gets matched against every active
// completion-correction relation on each listActive() call.
const CORRECTION_LOOKBACK_HOURS = 48;

/** 'done' commitments within CORRECTION_LOOKBACK_HOURS — candidates a fresh
 *  completion correction ("I did not complete X") could plausibly reverse. */
async function recentlyDone({ limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT * FROM commitments
      WHERE status = 'done' AND completed_at >= now() - ($1 * interval '1 hour')
      ORDER BY completed_at DESC
      LIMIT $2`,
    [CORRECTION_LOOKBACK_HOURS, limit]
  );
  return rows;
}

/**
 * Overlay any active, unsuperseded 'not completed' correction onto `rows` —
 * a commitment marked done (an explicit markDone, or the metric-driven
 * auto-complete in notify/commitments.js acting on stale/coincidental
 * evidence) must stop reading as done everywhere the canonical
 * listActive() projection is consumed (the mobile commitments card,
 * BrainSnapshot -> briefing/Ask/realtime, action ranking) once the user
 * explicitly says otherwise (harden pass, item 3b) — not merely be
 * queryable via getCompletionState directly.
 *
 * Read-only: NEVER mutates the stored `status` column. A later, real
 * markDone() naturally wins again on the next call without any race,
 * because matchCompletionCorrections compares timestamps itself — this
 * function doesn't need its own supersession logic.
 *
 * Best-effort: a resolver failure must never break the commitments card;
 * on error this returns `rows` unchanged.
 */
async function applyCompletionCorrections(rows) {
  if (!rows.length) return rows;
  try {
    const { resolveContext, matchCompletionCorrections } = require('../intelligence/context-resolver');
    const resolved = await resolveContext({});
    const overrides = matchCompletionCorrections(resolved, {
      items: rows, targetType: 'commitment',
      getText: (r) => r.title, getCompletedAt: (r) => r.completed_at,
    });
    if (!overrides.size) return rows;
    return rows.map((r) => {
      const ov = overrides.get(r.id);
      if (!ov || ov.completed !== false || r.status !== 'done') return r;
      return { ...r, status: 'open', completion_corrected: true };
    });
  } catch (e) {
    console.error('[commitments] applyCompletionCorrections failed:', e.message);
    return rows;
  }
}

/** Open commitments, soonest-due first (untimed last), newest tie-break —
 *  PLUS any recently-done commitment a completion correction resurrected
 *  back to effectively-open (see applyCompletionCorrections). For the card,
 *  and the ONE canonical read every other surface (BrainSnapshot, Ask,
 *  realtime, action ranking) shares. */
async function listActive({ limit = 20 } = {}) {
  const [{ rows: openRows }, doneRows] = await Promise.all([
    query(
      `SELECT * FROM commitments
        WHERE status = 'open'
        ORDER BY due_at ASC NULLS LAST, created_at DESC
        LIMIT $1`,
      [limit]
    ),
    recentlyDone(),
  ]);
  const corrected = await applyCompletionCorrections([...openRows, ...doneRows]);
  const active = corrected.filter((r) => r.status === 'open');
  active.sort((a, b) => {
    if (a.due_at && b.due_at) return new Date(a.due_at) - new Date(b.due_at);
    if (a.due_at) return -1;
    if (b.due_at) return 1;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  return active.slice(0, limit);
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
 * If this commitment is linked to a recommendation (recommendation_id set),
 * close the loop by writing an adherence outcome — the same ±1 delta
 * convention the manual thumbs-up/down endpoint already uses for recs with no
 * expected_direction. ONLY for metric-less recs: a metric-bearing rec's real
 * verdict comes from the 7-day measured delta (measureOutcomes), and
 * setOutcome is first-verdict-wins, so writing a synthetic adherence delta
 * here would permanently lock out that real measurement. Every rec gets a
 * linked commitment now (it's the one surface a rec shows up on), so this
 * gate is what keeps a metric-bearing rec's commitment tap from being more
 * than an acknowledgment. Never let this fail the caller's markDone/markSkipped.
 */
async function recordAdherenceOutcome(row, delta) {
  if (!row?.recommendation_id) return;
  const recommendations = require('./recommendations');
  let rec;
  try {
    rec = await recommendations.getById(row.recommendation_id);
  } catch (e) {
    console.error('[commitments] adherence outcome lookup failed:', e.message);
    return;
  }
  if (rec?.outcome_metric) return; // real measurement owns the verdict for these
  recommendations
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
  if (row) { recordAdherenceOutcome(row, 1); await invalidateCommitments(); }
  return row;
}

async function markSkipped(id) {
  const { rows } = await query(
    `UPDATE commitments SET status = 'skipped' WHERE id = $1 AND status = 'open' RETURNING *`,
    [id]
  );
  const row = rows[0] ?? null;
  if (row) { recordAdherenceOutcome(row, -1); await invalidateCommitments(); }
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
  deriveActionTitle,
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
