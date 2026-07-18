// Runtime invalidation bus — proves the registry's dependency graph ACTUALLY
// drives invalidation at runtime (versions bump, listeners fire), not just in
// documentation. This is the piece that was missing: invalidationSet() existed
// but nothing called it on a mutation.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const inv = require('../src/brain/invalidation');
const db = require('../src/db');
const { withTransaction } = require('../src/db');
const annotationsStore = require('../src/store/annotations');

after(async () => { await db.pool.end(); });

async function durableVersion(field) {
  const { rows } = await db.query(`SELECT version FROM brain_state_version WHERE field = $1`, [field]);
  return rows[0] ? Number(rows[0].version) : 0;
}

test('a recovery_change bumps recovery AND every registry-dependent field together', () => {
  const before = {
    recovery: inv.versionOf('recovery'),
    effectiveWorkout: inv.versionOf('effectiveWorkout'),
    todayForecast: inv.versionOf('todayForecast'),
    recoveryComposite: inv.versionOf('recoveryComposite'),
    wealth: inv.versionOf('wealth'),
  };
  const sv = inv.stateVersion();
  const res = inv.bump('recovery_change');

  assert.deepEqual(res.fields.slice().sort(),
    ['effectiveWorkout', 'recovery', 'recoveryComposite', 'todayForecast']);
  assert.equal(inv.versionOf('recovery'), before.recovery + 1);
  assert.equal(inv.versionOf('effectiveWorkout'), before.effectiveWorkout + 1);
  assert.equal(inv.versionOf('todayForecast'), before.todayForecast + 1);
  assert.equal(inv.versionOf('recoveryComposite'), before.recoveryComposite + 1);
  // An unrelated field is untouched.
  assert.equal(inv.versionOf('wealth'), before.wealth);
  assert.equal(inv.stateVersion(), sv + 1);
});

test('a workout_override bumps effectiveWorkout + todayForecast (forecast assumption)', () => {
  const bw = inv.versionOf('effectiveWorkout'), bf = inv.versionOf('todayForecast');
  const res = inv.bump('workout_override');
  assert.deepEqual(res.fields.slice().sort(), ['effectiveWorkout', 'todayForecast']);
  assert.equal(inv.versionOf('effectiveWorkout'), bw + 1);
  assert.equal(inv.versionOf('todayForecast'), bf + 1);
});

test('a transaction_sync bumps wealth only', () => {
  const b = inv.versionOf('wealth'), br = inv.versionOf('recovery');
  inv.bump('transaction_sync');
  assert.equal(inv.versionOf('wealth'), b + 1);
  assert.equal(inv.versionOf('recovery'), br); // untouched
});

test('registered listeners fire on invalidation of their field', () => {
  let fired = 0;
  inv.on('commitments', () => { fired += 1; });
  inv.bump('commitment_change');
  assert.equal(fired, 1);
  inv.bump('recovery_change'); // does not touch commitments
  assert.equal(fired, 1);
});

test('an unknown trigger is a no-op (no version churn)', () => {
  const sv = inv.stateVersion();
  const res = inv.bump('not_a_real_trigger');
  assert.deepEqual(res.fields, []);
  assert.equal(inv.stateVersion(), sv);
});

// ── Transactional Brain Invalidation (audit recommendation #2): bumpDurable()
// used to call bump() (which itself fire-and-forget persists) and THEN
// persist AGAIN itself, awaited — one mutation double-incremented the
// durable brain_state_version row. Proven here against the real durable
// store, not just the in-process cache, since that's exactly the layer the
// bug lived in. ───────────────────────────────────────────────────────────

test('bumpDurable(): persists each affected field EXACTLY ONCE in the durable store, not twice', async () => {
  // Drain any still-in-flight fire-and-forget persist() from an EARLIER
  // test's plain bump() call in this same file (shared global state, no
  // reset between tests) — otherwise a straggler landing mid-test would
  // look like this call double-persisted when it didn't.
  await new Promise((r) => setTimeout(r, 250));
  const before = await Promise.all(['recovery', 'effectiveWorkout', 'todayForecast', 'recoveryComposite', inv.GLOBAL_FIELD].map(durableVersion));
  await inv.bumpDurable('recovery_change');
  const after = await Promise.all(['recovery', 'effectiveWorkout', 'todayForecast', 'recoveryComposite', inv.GLOBAL_FIELD].map(durableVersion));
  after.forEach((v, i) => assert.equal(v, before[i] + 1, `field at index ${i} should have incremented by exactly 1 in the durable store, went from ${before[i]} to ${v}`));
});

test('bumpDurable(): the in-process cache and the durable store agree after one call (no drift from a double-persist)', async () => {
  const localBefore = inv.versionOf('recovery');
  const durableBefore = await durableVersion('recovery');
  await inv.bumpDurable('recovery_change');
  assert.equal(inv.versionOf('recovery'), localBefore + 1);
  assert.equal(await durableVersion('recovery'), durableBefore + 1);
});

test('bumpDurable(): a trigger with no registered fields never touches the durable store at all', async () => {
  const globalBefore = await durableVersion(inv.GLOBAL_FIELD);
  const result = await inv.bumpDurable('not_a_real_trigger');
  assert.deepEqual(result.fields, []);
  assert.equal(await durableVersion(inv.GLOBAL_FIELD), globalBefore, 'an unknown trigger must never bump the global durable counter');
});

test('bump() (fire-and-forget) still eventually persists exactly once — same guarantee, different await style', async () => {
  const before = await durableVersion('wealth');
  inv.bump('transaction_sync');
  // persist() is fire-and-forget from bump(); give its microtask/DB
  // round-trip a moment to land before asserting the durable store.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await durableVersion('wealth'), before + 1);
});

// ── Transactional Brain Invalidation (audit recommendation #2), item 5: a
// rolled-back transaction must never invalidate anything. Production code
// (routes/annotations.js, intelligence/context-input.js,
// services/recompute-wealth.js) always places its bumpDurable() call AFTER
// (not inside) its withTransaction(...) call, so a rejected transaction's
// `await` throws before that line is ever reached. This test proves BOTH
// halves of the guarantee against the real DB: the write itself rolled back
// (the row never lands), and the exact same statement-ordering pattern those
// callers use never reaches invalidation. ──────────────────────────────────
test('a transaction that rolls back never reaches its post-commit invalidation, and the write itself never lands', async () => {
  const before = inv.versionOf('eligibleContext');
  const label = `brain-invalidation-rollback-test-${Date.now()}`;
  let threw = false;
  try {
    // Mirrors the exact shape production callers use: write inside the
    // transaction via an injected client, invalidate strictly after — except
    // here the transaction deliberately fails, so the line after it must
    // never execute.
    await withTransaction(async (client) => {
      const dbFn = (text, params) => client.query(text, params);
      await annotationsStore.createAnnotation({ startTs: new Date().toISOString(), category: 'test', label }, dbFn);
      throw new Error('forced rollback');
    });
    await inv.bumpDurable('annotation_retirement'); // must never run
  } catch (err) {
    threw = true;
  }
  assert.equal(threw, true, 'the forced failure must propagate out of withTransaction');
  assert.equal(inv.versionOf('eligibleContext'), before, 'no invalidation happened — the post-commit line was never reached');
  const { rows } = await db.query('SELECT 1 FROM annotations WHERE label = $1', [label]);
  assert.equal(rows.length, 0, 'the annotation write itself rolled back — it never committed');
});
