// Bug: red recovery auto-swapped today's session to Mobility on the Health
// tab, but nothing server-side knew about it — the chief brief's "Today's
// workout" line kept describing the ORIGINAL scheduled session, so the LLM
// told the user to "scale back today's Push" when Push wasn't even happening
// anymore. getEffectiveWorkout() (services/workout.js) now applies the same
// recovery-based downgrade the mobile client applies (services/workout.js's
// autoDowngradeFor — unit-tested separately), with precedence: manual
// workout_overrides > automatic recovery downgrade > static schedule.
//
// These tests exercise the FULL async contract against a real DB: the
// override lookup, the returned shape (source/scheduledWorkoutId/
// scheduledLabel/recoveryBand — exactly what routes/briefing.js's
// resolveWorkoutForPrompt depends on to build the LLM-facing auto-swap note),
// and the self-fetch-band-via-liveRecovery() default path used by every
// caller that doesn't already have a band in hand (evening-brief.js,
// chat/ask.js, the chief-brief prompt builder).
const test = require('node:test');
const { afterEach, after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const { getEffectiveWorkout } = require('../../src/services/workout');

const TZ = process.env.TZ || 'America/New_York';
// July 2026: the 16th is a Thursday (scheduled Push).
const THU_NOON = new Date('2026-07-16T16:00:00.000Z'); // 12:00 PM EDT
const THU_DATE = '2026-07-16';

async function cleanup() {
  await db.query(`DELETE FROM workout_overrides WHERE log_date = $1`, [THU_DATE]);
}

afterEach(cleanup);
after(async () => { await cleanup(); await closeDb(); });

test('no override + red band => full auto_downgrade contract (scheduled Push, downgraded to Mobility)', async () => {
  const eff = await getEffectiveWorkout({ asOf: THU_NOON, tz: TZ, band: 'red' });
  assert.equal(eff.source, 'auto_downgrade');
  assert.equal(eff.workoutId, 'mobility');
  assert.equal(eff.label, 'Mobility');
  assert.ok(eff.duration, 'a duration string is provided for the downgraded session');
  assert.equal(eff.isHard, false);
  assert.equal(eff.scheduledWorkoutId, 'push');
  assert.equal(eff.scheduledLabel, 'Push');
  assert.equal(eff.recoveryBand, 'red');
});

test('a manual override wins over the automatic downgrade — and carries the scheduled baseline it replaced (but no recoveryBand/duration)', async () => {
  await db.query(`INSERT INTO workout_overrides (log_date, workout_id) VALUES ($1, 'zone2')`, [THU_DATE]);
  const eff = await getEffectiveWorkout({ asOf: THU_NOON, tz: TZ, band: 'red' });
  assert.equal(eff.source, 'override');
  assert.equal(eff.workoutId, 'zone2');
  assert.equal(eff.label, 'Zone 2');
  // The override now ALWAYS carries the scheduled baseline it replaced, so the
  // claim validator can catch a brief that describes the original scheduled
  // session ("crush your Push") after the user overrode it away. (This is the
  // deliberate contract change from the central-brain audit — override results
  // used to omit these.)
  assert.equal(eff.scheduledWorkoutId, 'push');
  assert.equal(eff.scheduledLabel, 'Push');
  // …but auto-downgrade-only metadata stays absent for an override.
  assert.equal(eff.recoveryBand, undefined, 'recoveryBand is auto_downgrade-only, not on an override');
  assert.equal(eff.duration, undefined, 'no synthesized downgrade duration on an override');
});

test('green band => unchanged scheduled result, source stays "scheduled"', async () => {
  const eff = await getEffectiveWorkout({ asOf: THU_NOON, tz: TZ, band: 'green' });
  assert.equal(eff.source, 'scheduled');
  assert.equal(eff.workoutId, 'push');
  assert.equal(eff.label, 'Push');
});

test('band omitted entirely => self-fetches via liveRecovery() and never throws, even with no recovery data', async () => {
  // No HRV/RHR seeded for this test — liveRecovery() should degrade to "no
  // score" gracefully, and getEffectiveWorkout() must fall back to the plain
  // scheduled plan rather than crash or silently downgrade on absent data.
  const eff = await getEffectiveWorkout({ asOf: THU_NOON, tz: TZ });
  assert.equal(eff.source, 'scheduled');
  assert.equal(eff.workoutId, 'push');
});
