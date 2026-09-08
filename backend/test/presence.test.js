// Presence pacing — the tests are about restraint.
//
// This module decides how often NormOS is allowed to re-ask "is anything worth
// saying?". Get it wrong in the permissive direction and a single Apple Health
// sync triggers a few hundred evaluations; an assistant that speaks whenever it
// can is one you turn off. Get it wrong in the other direction and nothing
// changes at all.
//
// So: a quiet period must cost ZERO passes, a burst must collapse to ONE, the
// floor between passes must hold no matter how eventful things get, and a
// source that never stops writing must not be able to starve evaluation.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldEvaluate,
  recordTrigger,
  afterEvaluation,
  REACTIVE_TRIGGERS,
  DEBOUNCE_MS,
  MIN_INTERVAL_MS,
  MAX_DEFER_MS,
} = require('../src/intelligence/presence');
const { TRIGGER } = require('../src/brain/registry');

const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;

// --- the core rule: no change, no pass -----------------------------------

test('a quiet period costs nothing — presence is driven by change, not by time', () => {
  // The whole thesis. However long it has been, with nothing changed there is
  // nothing to re-ask about.
  for (const elapsed of [0, 60 * MIN, 24 * 60 * MIN]) {
    const d = shouldEvaluate({ lastEvaluatedAt: T0, lastBumpAt: null }, T0 + elapsed);
    assert.equal(d.evaluate, false, `evaluated after ${elapsed / MIN}min of silence`);
    assert.equal(d.reason, 'nothing_changed');
  }
});

test('a first-ever change is evaluated once it settles, with no prior pass', () => {
  const d = shouldEvaluate({ lastEvaluatedAt: null, lastBumpAt: T0, firstBumpAt: T0 }, T0 + DEBOUNCE_MS);
  assert.equal(d.evaluate, true);
  assert.equal(d.reason, 'settled');
});

// --- a burst is one change ----------------------------------------------

test('a burst of writes is held until it settles, then evaluated once', () => {
  // 200 metric rows from one sync, arriving over 30 seconds.
  let state = { lastEvaluatedAt: T0 - 60 * MIN, lastBumpAt: null, firstBumpAt: null, triggers: [] };
  for (let i = 0; i < 200; i++) {
    const at = T0 + i * 150;
    state = recordTrigger(state, TRIGGER.RECOVERY_CHANGE, at);
    assert.equal(shouldEvaluate(state, at).evaluate, false, 'must not fire mid-burst');
  }
  const lastWrite = T0 + 199 * 150;
  assert.equal(shouldEvaluate(state, lastWrite + DEBOUNCE_MS - 1).reason, 'debouncing');
  assert.equal(shouldEvaluate(state, lastWrite + DEBOUNCE_MS).evaluate, true, 'one pass once the writes stop');
});

test('the same change is never evaluated twice — pending state is consumed', () => {
  let state = recordTrigger({ lastEvaluatedAt: T0 - 60 * MIN }, TRIGGER.RECOVERY_CHANGE, T0);
  const at = T0 + DEBOUNCE_MS;
  assert.equal(shouldEvaluate(state, at).evaluate, true);
  state = afterEvaluation(state, at);
  assert.equal(shouldEvaluate(state, at + 60 * MIN).reason, 'nothing_changed',
    'a consumed change must not keep re-firing forever');
});

// --- the floor between passes -------------------------------------------

test('the floor between passes holds however eventful things get', () => {
  const state = { lastEvaluatedAt: T0, lastBumpAt: T0 + 1, firstBumpAt: T0 + 1 };
  assert.equal(shouldEvaluate(state, T0 + MIN_INTERVAL_MS - 1).reason, 'min_interval');
  // And it outranks a settled debounce — a change settling two minutes after
  // the last pass still waits.
  const settled = { lastEvaluatedAt: T0, lastBumpAt: T0 + MIN, firstBumpAt: T0 + MIN };
  assert.equal(shouldEvaluate(settled, T0 + MIN + DEBOUNCE_MS).evaluate, false);
});

test('an eventful hour produces a handful of passes, not hundreds', () => {
  // Continuous change for an hour: a trigger every 10 seconds, forever.
  let state = { lastEvaluatedAt: T0, lastBumpAt: null, firstBumpAt: null, triggers: [] };
  let passes = 0;
  for (let t = T0; t <= T0 + 60 * MIN; t += 10 * 1000) {
    state = recordTrigger(state, TRIGGER.TRANSACTION_SYNC, t);
    if (shouldEvaluate(state, t).evaluate) {
      passes += 1;
      state = afterEvaluation(state, t);
    }
  }
  assert.ok(passes >= 1, 'a permanently-noisy source must still be evaluated');
  assert.ok(passes <= 7, `an hour of constant change produced ${passes} passes`);
});

// --- the deferral ceiling ------------------------------------------------

test('a source that never settles cannot starve evaluation forever', () => {
  // A sync dribbling a row every 30s for an hour never lets the debounce
  // settle. Without the ceiling, nothing would ever be evaluated.
  let state = { lastEvaluatedAt: T0 - 60 * MIN, lastBumpAt: null, firstBumpAt: null, triggers: [] };
  let firedAt = null;
  for (let t = T0; t < T0 + 60 * MIN && firedAt === null; t += 30 * 1000) {
    state = recordTrigger(state, TRIGGER.TRANSACTION_SYNC, t);
    if (shouldEvaluate(state, t).evaluate) firedAt = t;
  }
  assert.ok(firedAt !== null, 'the ceiling must eventually force a pass');
  assert.equal(firedAt - T0, MAX_DEFER_MS, 'and it fires at the ceiling, measured from the FIRST pending change');
});

test('the ceiling is measured from the first pending change, not the latest', () => {
  // Measuring from the latest would make it unreachable while writes continue,
  // which is exactly the starvation it exists to prevent.
  const state = { lastEvaluatedAt: T0 - 60 * MIN, firstBumpAt: T0, lastBumpAt: T0 + MAX_DEFER_MS - 1000 };
  assert.equal(shouldEvaluate(state, T0 + MAX_DEFER_MS).reason, 'max_defer');
});

// --- which changes count -------------------------------------------------

test('only user-relevant state changes count as a pending change', () => {
  const state = { lastEvaluatedAt: T0 - 60 * MIN, lastBumpAt: null, firstBumpAt: null, triggers: [] };
  // Typing into the app is not a reason for the app to interrupt you.
  const ignored = recordTrigger(state, TRIGGER.CONTEXT_TAG_CHANGE, T0);
  assert.equal(ignored.lastBumpAt, null, 'a non-reactive trigger must not even register as pending');
  assert.equal(shouldEvaluate(ignored, T0 + 60 * MIN).reason, 'nothing_changed');
  // An unknown trigger name likewise cannot schedule work.
  assert.equal(recordTrigger(state, 'something_new', T0).lastBumpAt, null);
});

test('the reactive set covers the signals that are actually time-sensitive', () => {
  // Named explicitly so adding a trigger to the registry doesn't silently
  // change presence behaviour in either direction.
  assert.ok(REACTIVE_TRIGGERS.has(TRIGGER.RECOVERY_CHANGE));
  assert.ok(REACTIVE_TRIGGERS.has(TRIGGER.TRANSACTION_SYNC));
  assert.ok(REACTIVE_TRIGGERS.has(TRIGGER.COMMITMENT_CHANGE));
  // Goal edits are the user typing into the app while looking at it.
  assert.ok(!REACTIVE_TRIGGERS.has(TRIGGER.GOAL_CHANGE));
  assert.ok(!REACTIVE_TRIGGERS.has(TRIGGER.CONTEXT_TAG_CHANGE));
});

test('recordTrigger accumulates distinct triggers without mutating the prior state', () => {
  const before = { lastEvaluatedAt: T0, lastBumpAt: null, firstBumpAt: null, triggers: [] };
  const a = recordTrigger(before, TRIGGER.RECOVERY_CHANGE, T0 + 1);
  const b = recordTrigger(a, TRIGGER.TRANSACTION_SYNC, T0 + 2);
  const c = recordTrigger(b, TRIGGER.RECOVERY_CHANGE, T0 + 3);
  assert.deepEqual(before.triggers, [], 'the prior state must not be mutated');
  assert.deepEqual(c.triggers.sort(), [TRIGGER.RECOVERY_CHANGE, TRIGGER.TRANSACTION_SYNC].sort());
  assert.equal(c.firstBumpAt, T0 + 1, 'the first pending change is remembered');
  assert.equal(c.lastBumpAt, T0 + 3);
});

// --- what this module deliberately does NOT do ---------------------------

test('presence does not re-implement quiet hours or the interrupt budget', () => {
  // Those belong to the Attention Policy, which already gets them right and —
  // crucially — can DEFER a quiet-hours event into the morning brief rather
  // than drop it. A second copy here would drift and would lose that.
  const src = require('node:fs').readFileSync(require.resolve('../src/intelligence/presence'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(!/quietHours|QUIET_|budget|BUDGET/.test(code),
    'quiet hours and budget must stay the Attention Policy’s job');
});
