// Bug: Tuesday morning, today's authoritative plan was "Recovery + Mobility"
// (not hard) but tomorrow's forecast said "today's hard session adds
// fatigue". Root cause: computeTodayForecast() inferred hardSessionToday
// purely from active_energy > 1.3x the 30-day mean, taking whatever row
// happened to be LAST in the window without proving it was actually today
// (a Monday hard session's elevated active energy could be misread as
// Tuesday's), and never consulted the authoritative workout plan or
// workout_overrides at all.
//
// Fixed by determining today's training pressure from the effective plan
// (workout_overrides first, else the scheduled split — services/workout.js's
// getEffectiveWorkout) AND explicit same-local-day completion evidence
// (activity_logs / the exercise habit), with active_energy removed entirely
// as hard-session evidence.
const test = require('node:test');
const { afterEach, after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const { computeTodayForecast } = require('../../src/intelligence/predict');

const TZ = process.env.TZ || 'America/New_York';
const REC = { score: 70, parts: { hrv: 60 } }; // pre-supplied so liveRecovery() (which needs
// an 8+ day baseline) is never consulted — isolates the test to hard-session logic alone.

// Fixed calendar anchors so the plan-by-weekday is deterministic regardless of
// when this suite runs. July 2026: the 14th is a Tuesday (Recovery + Mobility,
// not hard), the 15th a Wednesday (4×4 Intervals, hard). Noon ET avoids any
// midnight-boundary ambiguity for the "which day is this" tests below, which
// use their own explicit near-midnight anchors.
const TUE_NOON = new Date('2026-07-14T16:00:00.000Z'); // 12:00 PM EDT, Tuesday
const WED_NOON = new Date('2026-07-15T16:00:00.000Z'); // 12:00 PM EDT, Wednesday
const MON_DATE = '2026-07-13';
const TUE_DATE = '2026-07-14';
const WED_DATE = '2026-07-15';

async function cleanup() {
  await db.query(`DELETE FROM workout_overrides WHERE log_date IN ($1, $2, $3)`, [MON_DATE, TUE_DATE, WED_DATE]);
  await db.query(`DELETE FROM activity_logs WHERE log_date IN ($1, $2, $3)`, [MON_DATE, TUE_DATE, WED_DATE]);
  await db.query(
    `DELETE FROM metrics WHERE domain IN ('habits', 'health') AND metric IN ('exercise', 'active_energy')
       AND (ts AT TIME ZONE $1)::date IN ($2::date, $3::date, $4::date)`,
    [TZ, MON_DATE, TUE_DATE, WED_DATE]
  );
}

afterEach(cleanup);
after(async () => { await cleanup(); await closeDb(); });

test('Tuesday Recovery + Mobility plus a high active-energy row from Monday => no hard-session drag', async () => {
  // Monday's active energy is deliberately way above any plausible mean —
  // under the OLD logic this alone was enough to set hardSessionToday=true.
  await db.query(
    `INSERT INTO metrics (ts, domain, metric, value, unit, source) VALUES ($1, 'health', 'active_energy', 900, 'kcal', 'apple_health')`,
    [`${MON_DATE}T18:00:00Z`]
  );
  const { tomorrow } = await computeTodayForecast({ recovery: REC, asOf: TUE_NOON });
  assert.ok(tomorrow, 'sanity: a forecast was produced');
  assert.doesNotMatch(tomorrow.detail, /hard session/i);
});

test('a manual rest override on an otherwise-hard day (Wednesday/Intervals) => no hard-session drag', async () => {
  await db.query(
    `INSERT INTO workout_overrides (log_date, workout_id) VALUES ($1, 'rest')`,
    [WED_DATE]
  );
  const { tomorrow } = await computeTodayForecast({ recovery: REC, asOf: WED_NOON });
  assert.doesNotMatch(tomorrow.detail, /hard session/i);
});

test('the latest active-energy row being YESTERDAY is never treated as today\'s evidence', async () => {
  // Today (Wednesday) has no active_energy row at all; only yesterday does.
  // Under the old "take the last row in the window" logic this row could be
  // misread as today's regardless of which day it actually landed on.
  await db.query(
    `INSERT INTO metrics (ts, domain, metric, value, unit, source) VALUES ($1, 'health', 'active_energy', 1200, 'kcal', 'apple_health')`,
    [`${TUE_DATE}T18:00:00Z`]
  );
  const { tomorrow } = await computeTodayForecast({ recovery: REC, asOf: WED_NOON });
  // Wednesday is a scheduled Intervals (hard) day with no completion evidence
  // yet — PLANNED wording, not the unrelated active-energy spike driving it.
  assert.match(tomorrow.detail, /planned hard session may add fatigue/i);
});

test('same-day explicitly completed hard workout (unplanned, logged) => hard-session drag with COMPLETED wording', async () => {
  // Tuesday's plan is Recovery + Mobility (not hard), but the user logged an
  // actual hard session anyway — explicit same-day evidence must still count.
  await db.query(
    `INSERT INTO activity_logs (log_date, activity_type, label) VALUES ($1, 'intervals', 'Unplanned hard intervals')`,
    [TUE_DATE]
  );
  const { tomorrow } = await computeTodayForecast({ recovery: REC, asOf: TUE_NOON });
  assert.match(tomorrow.detail, /today's hard session adds fatigue/i);
  assert.doesNotMatch(tomorrow.detail, /planned hard session may add fatigue/i);
});

test('planned hard workout not yet completed => only PLANNED/provisional wording', async () => {
  // Wednesday is scheduled Intervals; nothing logged yet (still morning).
  const { tomorrow } = await computeTodayForecast({ recovery: REC, asOf: WED_NOON });
  assert.match(tomorrow.detail, /today's planned hard session may add fatigue/i);
  assert.doesNotMatch(tomorrow.detail, /today's hard session adds fatigue\b/i);
});

test('the exercise habit alone (no activity_type) confirms completion only when the plan itself is hard', async () => {
  // Wednesday/Intervals is hard: checking the generic "exercise" habit is
  // enough corroborating evidence to call it COMPLETED.
  await db.query(
    `INSERT INTO metrics (ts, domain, metric, value, unit, source) VALUES ($1, 'habits', 'exercise', 1, '', 'checkin')`,
    [`${WED_DATE}T20:00:00Z`]
  );
  const { tomorrow } = await computeTodayForecast({ recovery: REC, asOf: WED_NOON });
  assert.match(tomorrow.detail, /today's hard session adds fatigue/i);
});

test('the exercise habit alone on a NOT-hard day (Tuesday) does not manufacture a hard-session drag', async () => {
  await db.query(
    `INSERT INTO metrics (ts, domain, metric, value, unit, source) VALUES ($1, 'habits', 'exercise', 1, '', 'checkin')`,
    [`${TUE_DATE}T20:00:00Z`]
  );
  const { tomorrow } = await computeTodayForecast({ recovery: REC, asOf: TUE_NOON });
  assert.doesNotMatch(tomorrow.detail, /hard session/i);
});

test('timezone boundary: 11:58 PM ET Tuesday still resolves to Tuesday\'s (not-hard) plan', async () => {
  const justBeforeMidnight = new Date('2026-07-15T03:58:00.000Z'); // 11:58 PM EDT, still July 14 (Tuesday)
  const { tomorrow } = await computeTodayForecast({ recovery: REC, asOf: justBeforeMidnight });
  assert.doesNotMatch(tomorrow.detail, /hard session/i);
});

test('timezone boundary: 12:02 AM ET Wednesday resolves to Wednesday\'s (hard) plan', async () => {
  const justAfterMidnight = new Date('2026-07-15T04:02:00.000Z'); // 12:02 AM EDT, July 15 (Wednesday)
  const { tomorrow } = await computeTodayForecast({ recovery: REC, asOf: justAfterMidnight });
  assert.match(tomorrow.detail, /today's planned hard session may add fatigue/i);
});

// ── recovery-based auto-downgrade ────────────────────────────────────────────
// Bug: red recovery auto-swapped today's Health-tab session to Mobility, but
// the chief brief (and this forecast) still treated the ORIGINAL scheduled
// session as today's plan. getEffectiveWorkout() now applies the same
// recovery-based downgrade the mobile client's getTodaysWorkout() applies, so
// a red-recovery day's "planned" session is correctly Mobility (not hard) —
// even when the raw schedule called for something hard.

test('red recovery auto-downgrades a scheduled hard day (Wednesday/Intervals) to Mobility => no hard-session drag', async () => {
  const RED = { score: 20, band: 'red', parts: { hrv: 20 } };
  const { tomorrow } = await computeTodayForecast({ recovery: RED, asOf: WED_NOON });
  assert.doesNotMatch(tomorrow.detail, /hard session/i, 'the effective plan is Mobility on a red day, not the scheduled Intervals');
});

test('red recovery auto-downgrades a scheduled Push day to Mobility => no hard-session drag (the exact production report)', async () => {
  // Thursday is the scheduled Push day.
  const THU_NOON = new Date('2026-07-16T16:00:00.000Z'); // 12:00 PM EDT, Thursday
  const RED = { score: 27, band: 'red', parts: { hrv: 27 } };
  const { tomorrow } = await computeTodayForecast({ recovery: RED, asOf: THU_NOON });
  assert.doesNotMatch(tomorrow.detail, /hard session/i);
});

test('a manual override still wins over the automatic recovery downgrade', async () => {
  // Wednesday is scheduled Intervals; manually overridden to Push (still hard) —
  // the manual choice must take precedence over the automatic red-day downgrade.
  await db.query(`INSERT INTO workout_overrides (log_date, workout_id) VALUES ($1, 'push')`, [WED_DATE]);
  const RED = { score: 15, band: 'red', parts: { hrv: 15 } };
  const { tomorrow } = await computeTodayForecast({ recovery: RED, asOf: WED_NOON });
  assert.match(tomorrow.detail, /today's planned hard session may add fatigue/i, 'the manual override (Push) must still be treated as hard, not silently downgraded');
});

test('yellow recovery downgrades a scheduled Pull to Zone 2 => no hard-session drag', async () => {
  const SUN_NOON = new Date('2026-07-19T16:00:00.000Z'); // 12:00 PM EDT, Sunday (Pull day)
  const YELLOW = { score: 50, band: 'yellow', parts: { hrv: 40 } };
  const { tomorrow } = await computeTodayForecast({ recovery: YELLOW, asOf: SUN_NOON });
  assert.doesNotMatch(tomorrow.detail, /hard session/i);
});

test('yellow recovery does NOT downgrade a scheduled Push (only Pull gets the yellow downgrade)', async () => {
  const THU_NOON = new Date('2026-07-16T16:00:00.000Z');
  const YELLOW = { score: 50, band: 'yellow', parts: { hrv: 40 } };
  const { tomorrow } = await computeTodayForecast({ recovery: YELLOW, asOf: THU_NOON });
  assert.match(tomorrow.detail, /today's planned hard session may add fatigue/i);
});

test('green recovery never downgrades — a scheduled hard day stays hard', async () => {
  const GREEN = { score: 80, band: 'green', parts: { hrv: 70 } };
  const { tomorrow } = await computeTodayForecast({ recovery: GREEN, asOf: WED_NOON });
  assert.match(tomorrow.detail, /today's planned hard session may add fatigue/i);
});
