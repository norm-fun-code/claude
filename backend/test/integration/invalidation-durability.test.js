// Real-Postgres coverage for the "genuinely durable" brain-invalidation fix
// (backend/src/brain/invalidation.js): bumpDurable() must REJECT when the
// durable write-through actually fails (not silently resolve as if it
// succeeded), no-op mutations must never churn a durable version for
// nothing observable having changed, a real mutation must increment each
// affected field's durable version exactly once, and a rolled-back write
// must never reach invalidation at all. See test/brain-invalidation.test.js
// for the pure in-process half of this bus's behavior (that file's tier
// runs before `npm run migrate` in CI, so anything touching
// brain_state_version/other tables belongs here, not there).
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const { withTransaction } = require('../../src/db');
const inv = require('../../src/brain/invalidation');
const goalsStore = require('../../src/store/goals');
const { setWorkoutOverride } = require('../../src/services/workout');

const ORIGINAL_QUERY = db.query;
const MARKER = `invdur-${Date.now()}`;

async function durableVersion(field) {
  const { rows } = await db.query('SELECT version FROM brain_state_version WHERE field = $1', [field]);
  return rows[0] ? Number(rows[0].version) : 0;
}

afterEach(async () => {
  db.query = ORIGINAL_QUERY;
});
after(async () => {
  await db.query(`DELETE FROM goals WHERE title LIKE $1`, [`%${MARKER}%`]);
  await db.query(`DELETE FROM workout_overrides WHERE log_date IN ('2026-05-01', '2026-05-02')`);
  await closeDb();
});

// ── (a) bumpDurable rejects on persistence failure; bump() stays best-effort ──

test('bumpDurable() rejects with InvalidationPersistError when the durable write genuinely fails', async () => {
  db.query = async (text, params) => {
    if (String(text).includes('brain_state_version')) throw new Error('simulated DB outage');
    return ORIGINAL_QUERY(text, params);
  };
  await assert.rejects(
    () => inv.bumpDurable('recovery_change'),
    (err) => {
      assert.ok(err instanceof inv.InvalidationPersistError, 'must reject with the named error type, not a generic Error');
      assert.ok(err.fields.length > 0, 'the error carries the field names that failed to persist');
      assert.doesNotMatch(err.message, /password|DATABASE_URL|postgres:\/\//i, 'never leaks connection details in the error message');
      return true;
    }
  );
});

test('bump() (fire-and-forget) never throws even when the SAME durable write would fail', async () => {
  db.query = async (text, params) => {
    if (String(text).includes('brain_state_version')) throw new Error('simulated DB outage');
    return ORIGINAL_QUERY(text, params);
  };
  // Must not throw synchronously, and the in-process cache must still have
  // applied (applyLocal runs before persistence is even attempted).
  const before = inv.versionOf('recovery');
  assert.doesNotThrow(() => inv.bump('recovery_change'));
  assert.equal(inv.versionOf('recovery'), before + 1, 'the in-process half still applies even though durable persistence will fail in the background');
  // Give the fire-and-forget persist() a moment to fail and swallow its own
  // error internally — if it were unhandled this would crash the process.
  await new Promise((r) => setTimeout(r, 200));
});

// ── (b) no-op mutations cause zero durable version increment ────────────────

test('setWorkoutOverride: re-applying the SAME override id is a no-op — zero version increment', async () => {
  await db.query(`DELETE FROM workout_overrides WHERE log_date = '2026-05-01'`);
  await setWorkoutOverride({ date: '2026-05-01', workoutId: 'zone2' }); // real change — establishes state
  const before = await durableVersion('effectiveWorkout');
  await setWorkoutOverride({ date: '2026-05-01', workoutId: 'zone2' }); // identical — no-op
  assert.equal(await durableVersion('effectiveWorkout'), before, 'setting the SAME workoutId again must not bump the durable version');
});

test('setWorkoutOverride: clearing a day that has no override at all is a no-op — zero version increment', async () => {
  await db.query(`DELETE FROM workout_overrides WHERE log_date = '2026-05-02'`);
  const before = await durableVersion('effectiveWorkout');
  await setWorkoutOverride({ date: '2026-05-02', workoutId: null }); // nothing to clear
  assert.equal(await durableVersion('effectiveWorkout'), before, 'clearing an already-absent override must not bump the durable version');
});

test('updateGoal: re-submitting the identical status/title is a no-op — zero version increment', async () => {
  const created = await goalsStore.createGoal({ title: `${MARKER} ship the deck`, status: undefined });
  const before = await durableVersion('goals');
  await goalsStore.updateGoal(created.id, { status: created.status, title: created.title });
  assert.equal(await durableVersion('goals'), before, 'resubmitting identical values must not bump the durable version');
});

test('updateGoal/deleteGoal on a nonexistent id are no-ops — zero version increment', async () => {
  const beforeUpdate = await durableVersion('goals');
  await goalsStore.updateGoal('00000000-0000-0000-0000-000000000000', { status: 'active' });
  assert.equal(await durableVersion('goals'), beforeUpdate);

  const beforeDelete = await durableVersion('goals');
  await goalsStore.deleteGoal('00000000-0000-0000-0000-000000000000');
  assert.equal(await durableVersion('goals'), beforeDelete);
});

// ── (c) a real mutation increments each affected durable version exactly once ──

test('a real goal creation increments BOTH goals and weeklyIntention durable versions exactly once (registry: GOAL_CHANGE)', async () => {
  const beforeGoals = await durableVersion('goals');
  const beforeIntention = await durableVersion('weeklyIntention');
  await goalsStore.createGoal({ title: `${MARKER} renew passport` });
  assert.equal(await durableVersion('goals'), beforeGoals + 1);
  assert.equal(await durableVersion('weeklyIntention'), beforeIntention + 1);
});

test('a real workout override change increments effectiveWorkout AND todayForecast durable versions exactly once', async () => {
  await db.query(`DELETE FROM workout_overrides WHERE log_date = '2026-05-01'`);
  const beforeWorkout = await durableVersion('effectiveWorkout');
  const beforeForecast = await durableVersion('todayForecast');
  await setWorkoutOverride({ date: '2026-05-01', workoutId: 'mobility' });
  assert.equal(await durableVersion('effectiveWorkout'), beforeWorkout + 1);
  assert.equal(await durableVersion('todayForecast'), beforeForecast + 1);
});

// ── (d) a rolled-back write causes zero invalidation ─────────────────────────

test('a workout-override write that rolls back never reaches invalidation, and the row itself never lands', async () => {
  await db.query(`DELETE FROM workout_overrides WHERE log_date = '2026-05-02'`);
  const before = await durableVersion('effectiveWorkout');
  let threw = false;
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO workout_overrides (log_date, workout_id) VALUES ($1, $2)`,
        ['2026-05-02', 'push']
      );
      throw new Error('forced rollback');
    });
    // Mirrors the real call sites' shape: invalidation is placed AFTER the
    // transaction resolves — unreachable here because the throw above
    // rejects the withTransaction call before this line.
    await inv.bumpDurable('workout_override', { date: '2026-05-02' });
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
  assert.equal(await durableVersion('effectiveWorkout'), before, 'no durable invalidation happened — the post-commit line was never reached');
  const { rows } = await db.query(`SELECT 1 FROM workout_overrides WHERE log_date = '2026-05-02'`);
  assert.equal(rows.length, 0, 'the write itself rolled back — it never committed');
});
