// The Act flow's preview/confirm gate, end-to-end through the REAL Express
// routes + REAL Postgres: a meaningful action (a workout swap) must be
// PROPOSED, not applied, until the user explicitly confirms it via
// POST /api/chat/confirm-action — and a low-stakes action (log_habit) keeps
// executing immediately on the strength of the user's own statement, exactly
// as it did before this change (chat/actionPolicy.js's per-action consent
// rule). Also proves confirm-action is idempotent and never claims success
// on a failed/invalid mutation.
'use strict';
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const { getEffectiveWorkout } = require('../../src/services/workout');
const invalidation = require('../../src/brain/invalidation');

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
const app = buildTestApp();
const axios = require('axios');
const originalAxiosPost = axios.post;

// Ending in "?" forces the FULL reasoning path (looksLikeCommand's own
// unconditional "ends in ? -> a question" rule) regardless of the
// command-style phrasing that follows — this is deliberate: it lets the
// test drive the SAME axios.post mock the existing ask-generation
// integration tests use, without also having to stand up the separate
// fast-path model provider.
const SWAP_QUESTION = 'ASK-CONFIRM-TEST can you swap my workout to zone2?';
const HABIT_QUESTION = 'ASK-CONFIRM-TEST can you log my cold shower?';

function tzToday() {
  const tz = process.env.TZ || 'America/New_York';
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

async function currentOverride() {
  const { rows } = await db.query('SELECT workout_id FROM workout_overrides WHERE log_date = $1', [tzToday()]);
  return rows[0]?.workout_id ?? null;
}

afterEach(async () => {
  axios.post = originalAxiosPost;
  await db.query('DELETE FROM chat_messages WHERE content LIKE $1', ['ASK-CONFIRM-TEST%']);
  await db.query('DELETE FROM workout_overrides WHERE log_date = $1', [tzToday()]);
});
after(async () => { await closeDb(); });

function mockLlmAnswer(text) {
  axios.post = async () => ({ data: { id: 'msg_confirm_test', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: {} } });
}

test('required: a meaningful action (swap_workout) is PROPOSED but NOT applied by POST /api/chat — no mutation before confirmation', async () => {
  mockLlmAnswer(`Sure — here's the plan for a Zone 2 swap.\n<action>{"type":"swap_workout","workoutId":"zone2"}</action>`);
  const before = await currentOverride();
  assert.equal(before, null, 'precondition: no override exists yet');

  const res = await request(app).post('/api/chat').set(authHeader()).send({ question: SWAP_QUESTION });
  assert.equal(res.status, 200);
  assert.equal(res.body.action, null, 'back-compat `action` field must be null — nothing executed yet');
  assert.equal(res.body.actions.length, 0, 'back-compat `actions` (executed) must be empty');

  const proposed = res.body.askResponse.proposedActions;
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].actionType, 'swap_workout');
  assert.equal(proposed[0].requiresConfirmation, true);
  assert.equal(proposed[0].executed, false);
  assert.equal(res.body.askResponse.intent, 'act');

  const after1 = await currentOverride();
  assert.equal(after1, null, 'the workout override table must be untouched until the user confirms');
});

test('required: confirming the proposed action executes it exactly once (idempotent on a repeat confirm) and updates the authoritative workout selector', async () => {
  mockLlmAnswer(`Sure — here's the plan for a Zone 2 swap.\n<action>{"type":"swap_workout","workoutId":"zone2"}</action>`);
  const askRes = await request(app).post('/api/chat').set(authHeader()).send({ question: SWAP_QUESTION });
  const proposedAction = askRes.body.askResponse.proposedActions[0].validatedPayload;

  const versionBefore = invalidation.versionOf('effectiveWorkout');

  const confirm1 = await request(app).post('/api/chat/confirm-action').set(authHeader()).send({ action: proposedAction });
  assert.equal(confirm1.status, 200);
  assert.equal(confirm1.body.ok, true);
  assert.equal(confirm1.body.result.done, true);

  // required: successful mutation invalidates the correct BrainSnapshot field.
  assert.ok(invalidation.versionOf('effectiveWorkout') > versionBefore, 'effectiveWorkout must be invalidated after a confirmed swap');

  // required: the confirmed swap matches Health/Today's authoritative selector.
  const effective = await getEffectiveWorkout();
  assert.equal(effective.workoutId, 'zone2');
  assert.equal(effective.source, 'override');

  const { rows } = await db.query('SELECT workout_id FROM workout_overrides WHERE log_date = $1', [tzToday()]);
  assert.equal(rows.length, 1, 'exactly one override row — a repeat confirm below must not create a second');

  // required: confirmed action executes exactly once — a second confirm tap
  // (e.g. a double-tap or a retried request) must not double-apply.
  const confirm2 = await request(app).post('/api/chat/confirm-action').set(authHeader()).send({ action: proposedAction });
  assert.equal(confirm2.status, 200);
  assert.equal(confirm2.body.ok, true);
  const { rows: rows2 } = await db.query('SELECT workout_id FROM workout_overrides WHERE log_date = $1', [tzToday()]);
  assert.equal(rows2.length, 1, 'still exactly one row after a repeat confirm — idempotent, not duplicated');
});

test('required: an invalid/malformed confirm payload is rejected and never described as completed', async () => {
  const res = await request(app).post('/api/chat/confirm-action').set(authHeader())
    .send({ action: { action: 'swap_workout', workoutId: 'not_a_real_workout' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_action');
  assert.equal(res.body.ok, undefined);
  const after1 = await currentOverride();
  assert.equal(after1, null);
});

test('a low-stakes action (log_habit) still executes immediately on the strength of the user\'s own statement — no confirm step, matching existing behavior', async () => {
  // 'exercise' (not 'gratitude'/'morningTM') deliberately — this writes a REAL
  // habits row through the unmocked ingest pipeline, and other integration
  // tests (consolidate-gather-parallel.test.js) assert exact aggregate rates
  // for gratitude/morning_tm against the shared test DB; polluting either
  // would make that test flaky depending on run order.
  mockLlmAnswer(`Done — logged your exercise.\n<action>{"type":"log_habit","habit":"exercise"}</action>`);
  const res = await request(app).post('/api/chat').set(authHeader()).send({ question: HABIT_QUESTION });
  assert.equal(res.status, 200);
  assert.equal(res.body.action?.done, true, 'back-compat `action` reflects the immediately-executed result');

  const proposed = res.body.askResponse.proposedActions;
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].requiresConfirmation, false);
  assert.equal(proposed[0].executed, true);
  assert.equal(proposed[0].executionResult.done, true);
});

test('required: text Ask (routes/chat.js) and voice Ask (routes/voice.js) apply the identical per-action consent policy and AskResponse builder — never two different ideas of "the answer"', () => {
  const fs = require('fs');
  const chatSrc = fs.readFileSync(require.resolve('../../src/routes/chat.js'), 'utf8');
  const voiceSrc = fs.readFileSync(require.resolve('../../src/routes/voice.js'), 'utf8');
  for (const src of [chatSrc, voiceSrc]) {
    assert.match(src, /require\(['"]\.\.\/chat\/actionPolicy['"]\)/, 'must consult the shared per-action consent policy');
    assert.match(src, /require\(['"]\.\.\/chat\/askResponse['"]\)/, 'must build the shared AskResponse contract');
    assert.match(src, /needsConfirmation/);
    assert.match(src, /buildAskResponse/);
  }
});
