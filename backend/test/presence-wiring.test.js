// Presence wiring — proof the subscription is live, not merely written.
//
// test/presence.test.js covers the pacing logic in isolation, and it would
// pass perfectly while the feature was completely dead: if a reactive trigger
// happened to invalidate no fields, or the bus didn't pass the trigger name to
// field listeners, nothing would ever be recorded as pending and presence
// would silently never run. That is the same defect class as the recovery-build
// adoption bug — a helper fully written, fully tested, and never called.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { REACTIVE_TRIGGERS, recordTrigger, shouldEvaluate, DEBOUNCE_MS } = require('../src/intelligence/presence');
const { invalidationSet } = require('../src/brain/registry');
const invalidation = require('../src/brain/invalidation');

test('every reactive trigger actually invalidates at least one field', () => {
  // A trigger that invalidates nothing fires no listeners, so presence would
  // never see it. This is the check that the allowlist and the registry agree.
  for (const trigger of REACTIVE_TRIGGERS) {
    const fields = invalidationSet(trigger);
    assert.ok(fields.length > 0, `${trigger} invalidates no fields — presence could never observe it`);
  }
});

test('the bus hands the trigger name to a field listener', () => {
  // The whole subscription depends on this signature. If listeners were called
  // with only (meta), every recordTrigger call would receive undefined and be
  // rejected by the allowlist — silently, since that path throws nothing.
  const trigger = [...REACTIVE_TRIGGERS][0];
  const field = invalidationSet(trigger)[0];
  const seen = [];
  invalidation.on(field, (_meta, gotField, gotTrigger) => seen.push({ gotField, gotTrigger }));
  invalidation.bump(trigger, { asOf: new Date() });
  assert.ok(seen.length > 0, 'the listener must fire');
  assert.equal(seen[0].gotTrigger, trigger, 'the trigger name must reach the listener');
  assert.equal(seen[0].gotField, field);
});

test('a real bump drives a pending change through to an evaluation', () => {
  // End to end through the real bus: subscribe exactly as the scheduler does,
  // bump for real, and confirm the pacing logic then agrees a pass is due.
  let state = { lastEvaluatedAt: Date.now() - 60 * 60 * 1000, lastBumpAt: null, firstBumpAt: null, triggers: [] };
  const trigger = [...REACTIVE_TRIGGERS][0];
  const fields = new Set();
  for (const t of REACTIVE_TRIGGERS) for (const f of invalidationSet(t)) fields.add(f);
  for (const f of fields) {
    invalidation.on(f, (_meta, _f, got) => { state = recordTrigger(state, got, Date.now()); });
  }

  assert.equal(shouldEvaluate(state, Date.now()).reason, 'nothing_changed');
  invalidation.bump(trigger, {});
  assert.ok(state.lastBumpAt, 'the bump must register as a pending change');
  assert.ok(state.triggers.includes(trigger));
  assert.equal(shouldEvaluate(state, state.lastBumpAt + DEBOUNCE_MS).evaluate, true);
});

test('the scheduler subscribes to the bus and paces through presence — not a hand-rolled timer', () => {
  const SRC = readFileSync(require.resolve('../src/scheduler'), 'utf8');
  assert.match(SRC, /require\('\.\/intelligence\/presence'\)/, 'presence must be used by the scheduler');
  assert.match(SRC, /invalidation\.on\(/, 'it must subscribe to the invalidation bus, not poll for changes');
  assert.match(SRC, /presence\.recordTrigger\(/, 'bumps must be recorded as pending changes');
  assert.match(SRC, /presence\.shouldEvaluate\(/, 'the pass must be gated by the pure pacing logic');
  assert.match(SRC, /presence\.afterEvaluation\(/, 'pending state must be consumed, or one change fires forever');
  assert.match(SRC, /PRESENCE_ENABLED/, 'a kill switch is required for a background loop that can push');
});

test('the pass consumes pending state BEFORE doing its work', () => {
  // Ordering matters: reset after the await and a change arriving mid-pass is
  // swallowed, so a signal that appeared during evaluation is never evaluated.
  const SRC = readFileSync(require.resolve('../src/scheduler'), 'utf8');
  const block = SRC.slice(SRC.indexOf('const presenceTick'), SRC.indexOf('setInterval(presenceTick'));
  assert.ok(
    block.indexOf('presence.afterEvaluation(') < block.indexOf('await runNudges'),
    'pending changes must be consumed before the pass runs, not after'
  );
  assert.match(block, /if \(presenceRunning\) return;/, 'overlapping passes would race the attention ledger');
});
