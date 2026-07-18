// Weekly intentions: the Sunday check-in (life context + focus goals). Upserted
// one row per week (keyed on the Sunday date). The intelligence layer reads
// recent entries as rolling context for the advisor, review, and insights.
//
// Goals are stored as `{ text, achieved }` objects so each Sunday you can look
// back at last week's goals and tick which ones you actually hit. Old rows that
// stored plain strings are normalized on read, so nothing breaks.
const { query } = require('../db');

// A weekly-intention write changes what the brief's "this week's focus"
// language and goal-completion claims may say — the registry declares
// GOAL_CHANGE invalidates both `goals` and `weeklyIntention`, so route every
// mutation here through the ONE bus rather than leaving a cached briefing's
// weeklyGoals card unaware a new intention/achievement was just recorded.
// Durable and awaited (not fire-and-forget): a Sunday-checkin write is
// user-facing-state the caller is about to confirm as saved (Transactional
// Brain Invalidation, audit recommendation #2, item 5).
//
// Deliberately UNGUARDED — see store/goals.js's invalidateGoals for the full
// rationale: bumpDurable() REJECTS on a genuine durable-persistence failure
// (InvalidationPersistError), and swallowing that here would let a caller
// believe cross-instance freshness was confirmed when it wasn't. The write
// above already committed; let the rejection propagate rather than retrying
// a non-idempotent mutation automatically.
async function invalidateIntentions() {
  await require('../brain/invalidation').bumpDurable('goal_change');
}

/** The Sunday (local) that starts the week containing `date`. YYYY-MM-DD. */
function weekStart(date = new Date(), tz = process.env.TZ || 'America/New_York') {
  // Get the local Y-M-D and weekday, then back up to Sunday.
  const ymd = date.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();          // 0=Sun..6=Sat
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** The Sunday before the one containing `date` (the prior week's key). */
function priorWeekStart(date = new Date(), tz = process.env.TZ || 'America/New_York') {
  const d = new Date(`${weekStart(date, tz)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/** Coerce a stored/incoming goals array into clean `{ text, achieved }` objects.
 *  Accepts plain strings (legacy + the card's new-goal inputs) or objects. */
function normalizeGoals(goals) {
  if (!Array.isArray(goals)) return [];
  return goals
    .map((g) => {
      if (g && typeof g === 'object') {
        return { text: String(g.text ?? '').trim(), achieved: g.achieved === true };
      }
      return { text: String(g ?? '').trim(), achieved: false };
    })
    .filter((g) => g.text)
    .slice(0, 5);
}

/** Upsert the current week's intention (context + goals). New goals default to
 *  not-yet-achieved; achievement is recorded later via `saveGoalResults`. */
async function saveIntention({ weekStart: ws, context = null, goals = [] } = {}) {
  const week = ws || weekStart();
  const clean = normalizeGoals(goals);
  const { rows } = await query(
    `INSERT INTO weekly_intentions (week_start, context, goals, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (week_start) DO UPDATE
       SET context = EXCLUDED.context, goals = EXCLUDED.goals, updated_at = now()
     RETURNING id, week_start, context, goals`,
    [week, context ? String(context).trim() : null, JSON.stringify(clean)]
  );
  const r = rows[0];
  if (r) await invalidateIntentions();
  return r ? { ...r, goals: normalizeGoals(r.goals) } : null;
}

/**
 * Record which of a week's goals were achieved. `achieved` is an array of
 * booleans aligned by index to that week's stored goals (defaults to the prior
 * week — the one you reflect on each Sunday). Returns the updated row, or null
 * if there's no intention for that week.
 */
async function saveGoalResults({ weekStart: ws, achieved = [] } = {}) {
  const week = ws || priorWeekStart();
  const { rows } = await query(
    `SELECT goals FROM weekly_intentions WHERE week_start = $1`,
    [week]
  );
  if (!rows[0]) return null;
  const goals = normalizeGoals(rows[0].goals).map((g, i) => ({
    text: g.text,
    achieved: achieved[i] === true,
  }));
  const { rows: out } = await query(
    `UPDATE weekly_intentions
        SET goals = $2::jsonb, updated_at = now()
      WHERE week_start = $1
      RETURNING week_start, context, goals`,
    [week, JSON.stringify(goals)]
  );
  const r = out[0];
  if (r) await invalidateIntentions();
  return r ? { weekStart: r.week_start, context: r.context, goals: normalizeGoals(r.goals) } : null;
}

/** Fetch a single week's intention by its Sunday key, or null. */
async function intentionForWeek(week) {
  const { rows } = await query(
    `SELECT week_start, context, goals FROM weekly_intentions WHERE week_start = $1`,
    [week]
  );
  const r = rows[0];
  return r ? { weekStart: r.week_start, context: r.context, goals: normalizeGoals(r.goals) } : null;
}

/** The current week's intention, or null if not set yet. */
async function currentIntention() {
  return intentionForWeek(weekStart());
}

/** The prior week's intention (so the Sunday card can show last week's goals to
 *  mark as achieved), or null if none was set. */
async function priorIntention() {
  return intentionForWeek(priorWeekStart());
}

/** Recent intentions within `days` (rolling context for the intelligence layer). */
async function recentIntentions({ days = 30 } = {}) {
  const { rows } = await query(
    `SELECT week_start, context, goals
       FROM weekly_intentions
      WHERE week_start >= (now() - ($1::int || ' days')::interval)::date
      ORDER BY week_start DESC`,
    [days]
  );
  return rows.map((r) => ({ weekStart: r.week_start, context: r.context, goals: normalizeGoals(r.goals) }));
}

/** Render a goals array as a prompt-friendly string, annotating achievement
 *  ("✓ hit" / "✗ missed") when it's been recorded. */
function formatGoals(goals) {
  return normalizeGoals(goals)
    .map((g) => (g.achieved === true ? `${g.text} (✓ hit)` : g.text))
    .join('; ');
}

module.exports = {
  saveIntention,
  saveGoalResults,
  currentIntention,
  priorIntention,
  intentionForWeek,
  recentIntentions,
  weekStart,
  priorWeekStart,
  normalizeGoals,
  formatGoals,
};
