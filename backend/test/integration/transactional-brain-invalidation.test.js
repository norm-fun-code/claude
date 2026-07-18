// Transactional Brain Invalidation (audit recommendation #2) — end-to-end
// coverage against a real Postgres + real Express app that every successful
// mutation emits exactly one durable invalidation, strictly after its
// database transaction commits. See src/brain/invalidation.js (bumpDurable
// double-persist fix + rollback semantics — test/brain-invalidation.test.js),
// src/store/annotations.js (now side-effect-free re: invalidation),
// src/routes/annotations.js (every CRUD path invalidates itself once, after
// commit), and src/services/workout.js's setWorkoutOverride (the ONE shared
// write+invalidate path for the REST route, Ask, and realtime voice).
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const { withTransaction } = require('../../src/db');
const inv = require('../../src/brain/invalidation');
const llm = require('../../src/llm');
const { executeAction } = require('../../src/chat/executeAction');
const { buildBrainSnapshot } = require('../../src/brain/snapshot');
const annotationsStore = require('../../src/store/annotations');

const app = buildTestApp();
const TZ = process.env.TZ || 'America/New_York';
const MARKER = `tbi-test-${Date.now()}`;
const ORIGINAL_GENERATE_TEXT = llm.generateText;

async function durableVersion(field) {
  const { rows } = await db.query('SELECT version FROM brain_state_version WHERE field = $1', [field]);
  return rows[0] ? Number(rows[0].version) : 0;
}

afterEach(async () => {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
});
after(async () => {
  await db.query('DELETE FROM annotations WHERE label LIKE $1', [`%${MARKER}%`]);
  await db.query(`DELETE FROM workout_overrides WHERE log_date IN ('2026-04-06', '2026-04-07')`);
  await closeDb();
});

// ── Annotation CRUD: each path invalidates exactly once, after commit ──────

test('POST /annotations invalidates annotation_retirement exactly once (durably)', async () => {
  const before = await durableVersion('eligibleContext');
  const res = await request(app).post('/api/annotations').set(authHeader()).send({
    startTs: new Date().toISOString(),
    category: 'brief_context',
    label: `${MARKER} create`,
  });
  assert.equal(res.status, 200);
  assert.equal(await durableVersion('eligibleContext'), before + 1, 'exactly one durable invalidation for the create');
});

test('PATCH /annotations/:id invalidates annotation_retirement exactly once (durably)', async () => {
  const created = await request(app).post('/api/annotations').set(authHeader()).send({
    startTs: new Date().toISOString(),
    category: 'brief_context',
    label: `${MARKER} edit-before`,
  });
  const before = await durableVersion('eligibleContext');
  const res = await request(app).patch(`/api/annotations/${created.body.id}`).set(authHeader()).send({
    label: `${MARKER} edit-after`,
  });
  assert.equal(res.status, 200);
  assert.equal(await durableVersion('eligibleContext'), before + 1, 'exactly one durable invalidation for the edit');
});

test('DELETE /annotations/:id invalidates annotation_retirement exactly once (durably) — the previously-missing path', async () => {
  const created = await request(app).post('/api/annotations').set(authHeader()).send({
    startTs: new Date().toISOString(),
    category: 'brief_context',
    label: `${MARKER} delete`,
  });
  const before = await durableVersion('eligibleContext');
  const res = await request(app).delete(`/api/annotations/${created.body.id}`).set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(await durableVersion('eligibleContext'), before + 1, 'exactly one durable invalidation for the delete');
});

// ── POST /briefing/context: the transactional multi-write route ───────────

test('POST /briefing/context invalidates annotation_retirement exactly once, and does NOT touch context_assertion_change when nothing compiled', async () => {
  llm.generateText = async () => ({ text: JSON.stringify({ assertions: [] }), stopReason: 'end_turn', requestId: 'test', model: 'claude-opus-4-8' });
  const beforeAnn = await durableVersion('eligibleContext');
  const beforeCtx = await durableVersion('resolvedContext');
  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: 'Anything unusual?',
    answer: `${MARKER} nothing unusual, quiet day`,
  });
  assert.equal(res.status, 200);
  assert.equal(await durableVersion('eligibleContext'), beforeAnn + 1, 'exactly one annotation invalidation for the write');
  assert.equal(await durableVersion('resolvedContext'), beforeCtx, 'no compiled assertions this time — context_assertion_change must not fire');
});

test('POST /briefing/context invalidates BOTH annotation_retirement and context_assertion_change exactly once each when the compiler produces an assertion', async () => {
  llm.generateText = async () => ({
    text: JSON.stringify({
      assertions: [{
        assertionType: 'event', subject: 'user', predicate: 'drank', objectValue: 'wine',
        concepts: ['alcohol'], domains: ['health'], eventStatus: 'occurred', temporalRef: 'last_night',
        explicitDate: '', correctsPriorText: '', confidence: 0.9,
      }],
    }),
    stopReason: 'end_turn', requestId: 'test', model: 'claude-opus-4-8',
  });
  const beforeAnn = await durableVersion('eligibleContext');
  const beforeCtx = await durableVersion('resolvedContext');
  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: 'Anything unusual last night?',
    answer: `${MARKER} had a couple glasses of wine`,
  });
  assert.equal(res.status, 200);
  assert.equal(await durableVersion('eligibleContext'), beforeAnn + 1, 'exactly one annotation invalidation');
  assert.equal(await durableVersion('resolvedContext'), beforeCtx + 1, 'exactly one context-assertion invalidation');

  await db.query(
    `DELETE FROM context_relations WHERE source_assertion_id IN (SELECT id FROM context_assertions WHERE raw_text LIKE $1)`,
    [`%${MARKER}%`]
  );
  await db.query(`DELETE FROM context_assertions WHERE raw_text LIKE $1`, [`%${MARKER}%`]);
});

// ── Workout overrides: REST route and Ask/realtime voice share ONE path ───

test('the REST override route and Ask/realtime voice (executeAction) produce IDENTICAL persisted state and invalidation via the shared setWorkoutOverride', async () => {
  const DATE_REST = '2026-04-06';
  const DATE_ASK = '2026-04-07';
  await db.query('DELETE FROM workout_overrides WHERE log_date IN ($1, $2)', [DATE_REST, DATE_ASK]);

  // REST path (mobile's manual day-swap UI).
  const beforeRest = await durableVersion('effectiveWorkout');
  const restRes = await request(app).post('/api/workout/override').set(authHeader()).send({ date: DATE_REST, workoutId: 'zone2' });
  assert.equal(restRes.status, 200);
  assert.equal(await durableVersion('effectiveWorkout'), beforeRest + 1, 'REST route invalidates exactly once');

  // Ask/realtime voice path — chat/executeAction.js's swap_workout branch,
  // the SAME function realtimeTools.js's execute_normos_action and
  // routes/chat.js / routes/voice.js's Ask flow all delegate to.
  const realDateForActionModule = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  await db.query('DELETE FROM workout_overrides WHERE log_date = $1', [realDateForActionModule]);
  const beforeAsk = await durableVersion('effectiveWorkout');
  const outcome = await executeAction({ action: 'swap_workout', workoutId: 'zone2' });
  assert.equal(outcome.done, true);
  assert.equal(await durableVersion('effectiveWorkout'), beforeAsk + 1, 'Ask/realtime path invalidates exactly once via the same helper');

  const { rows } = await db.query('SELECT workout_id FROM workout_overrides WHERE log_date = $1', [realDateForActionModule]);
  assert.equal(rows[0]?.workout_id, 'zone2', 'Ask/realtime voice persisted the override through the identical write path REST uses');

  await db.query('DELETE FROM workout_overrides WHERE log_date = $1', [realDateForActionModule]);
});

// ── A fresh BrainSnapshot sees committed state ─────────────────────────────

test('a fresh BrainSnapshot built after a mutation sees the committed annotation, not stale/cached state', async () => {
  const label = `${MARKER} snapshot-visibility`;
  const res = await request(app).post('/api/annotations').set(authHeader()).send({
    startTs: new Date().toISOString(),
    endTs: new Date(Date.now() + 3600_000).toISOString(),
    category: 'brief_context',
    label,
  });
  assert.equal(res.status, 200);

  const snapshot = await buildBrainSnapshot({ include: { calendar: false } });
  assert.ok(
    snapshot.eligibleContext.value.some((a) => a.label === label),
    'the annotation committed via the HTTP route is visible in a freshly-built BrainSnapshot'
  );
});

// ── bumpDurable()'s double-persist fix, proven against the real durable
// store (test/brain-invalidation.test.js covers the pure in-process half —
// this tier is where anything that queries brain_state_version/annotations
// directly belongs, since it's the only tier guaranteed to run AFTER
// `npm run migrate`, see test/integration/helpers.js) ──────────────────────

test('bumpDurable(): persists each affected field EXACTLY ONCE in the durable store, not twice', async () => {
  // Drain any still-in-flight fire-and-forget persist() from an earlier
  // test's plain bump() call (shared global state, no reset between tests)
  // — otherwise a straggler landing mid-test would look like this call
  // double-persisted when it didn't.
  await new Promise((r) => setTimeout(r, 250));
  const before = await Promise.all(['recovery', 'effectiveWorkout', 'todayForecast', 'recoveryComposite', inv.GLOBAL_FIELD].map(durableVersion));
  await inv.bumpDurable('recovery_change');
  const afterVals = await Promise.all(['recovery', 'effectiveWorkout', 'todayForecast', 'recoveryComposite', inv.GLOBAL_FIELD].map(durableVersion));
  afterVals.forEach((v, i) => assert.equal(v, before[i] + 1, `field at index ${i} should have incremented by exactly 1 in the durable store, went from ${before[i]} to ${v}`));
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

// ── Transactional Brain Invalidation, item 5: a rolled-back transaction must
// never invalidate anything. Production code (routes/annotations.js,
// intelligence/context-input.js, services/recompute-wealth.js) always places
// its bumpDurable() call AFTER (not inside) its withTransaction(...) call, so
// a rejected transaction's `await` throws before that line is ever reached.
// This proves BOTH halves against the real DB: the write itself rolled back
// (the row never lands), and the exact statement-ordering pattern those
// callers use never reaches invalidation. ──────────────────────────────────

test('a transaction that rolls back never reaches its post-commit invalidation, and the write itself never lands', async () => {
  const before = inv.versionOf('eligibleContext');
  const label = `${MARKER} rollback`;
  let threw = false;
  try {
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
