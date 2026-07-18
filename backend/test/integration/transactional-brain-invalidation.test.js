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
const inv = require('../../src/brain/invalidation');
const llm = require('../../src/llm');
const { executeAction } = require('../../src/chat/executeAction');
const { buildBrainSnapshot } = require('../../src/brain/snapshot');

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
