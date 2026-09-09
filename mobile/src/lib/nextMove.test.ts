import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_DECISION, decisionError, decisionPrompt, focusClock, focusRemaining, pauseFocus, restoreFocus, resumeFocus, startFocus } from './nextMove.ts';

const now = 1788944400000;
test('a decision needs distinct, nonempty options', () => {
  assert.ok(decisionError(EMPTY_DECISION));
  assert.ok(decisionError({ ...EMPTY_DECISION, question: 'Tonight?', optionA: 'Work', optionB: ' work ' }));
  assert.equal(decisionPrompt(EMPTY_DECISION), '');
});
test('decision handoff includes user priorities and asks for evidence and a counterargument', () => {
  const prompt = decisionPrompt({ question: ' Tonight? ', optionA: 'Finish a draft', optionB: 'Dinner with Nancy', lens: 'time', constraint: 'Protect an hour together' });
  for (const part of ['Decision: Tonight?', 'Option A: Finish a draft', 'Option B: Dinner with Nancy', 'Time & attention', 'Protect an hour together', 'stale or missing evidence', 'strongest case against', 'hypothetical', 'not a request to execute']) assert.ok(prompt.includes(part), part);
});
test('a running session uses an absolute deadline across a suspended app', () => {
  const s = startFocus('Write', 25, now);
  const restored = restoreFocus(JSON.stringify(s))!;
  assert.equal(focusRemaining(restored, now + 600000), 900000);
  assert.equal(focusRemaining(restored, now + 2000000), 0);
});
test('paused sessions do not lose time while away', () => {
  const paused = pauseFocus(startFocus('Read', 15, now), now + 120000);
  assert.equal(focusRemaining(paused, now + 3600000), 780000);
  const resumed = resumeFocus(restoreFocus(JSON.stringify(paused))!, now + 3600000);
  assert.equal(focusRemaining(resumed, now + 3660000), 720000);
});
test('repeated pause/resume preserves the remaining interval', () => {
  let s = startFocus('Walk', 45, now);
  s = pauseFocus(s, now + 60000);
  s = pauseFocus(s, now + 90000);
  s = resumeFocus(s, now + 100000);
  s = resumeFocus(s, now + 110000);
  assert.equal(focusRemaining(s, now + 120000), 2620000);
});
test('an elapsed timer stays elapsed when resumed', () => {
  const s = startFocus('Time together', 15, now);
  const resumed = resumeFocus(s, now + 1000000);
  assert.equal(resumed.endsAt, null);
  assert.equal(focusRemaining(resumed, now + 1200000), 0);
});
test('a wall clock moving backward cannot create more than the chosen duration', () => {
  assert.equal(focusRemaining(startFocus('Write', 25, now), now - 60000), 1500000);
});
test('restore rejects corrupt, unknown-version, or impossible sessions', () => {
  const s = startFocus('Write', 25, now);
  for (const value of [null, '{broken', JSON.stringify({ ...s, version: 2 }), JSON.stringify({ ...s, durationMs: 1 }), JSON.stringify({ ...s, remainingMs: -1 }), JSON.stringify({ ...s, endsAt: 'tomorrow' }), JSON.stringify({ ...s, startedAt: null }), JSON.stringify({ ...s, title: '' })]) assert.equal(restoreFocus(value), null);
});
test('a session can cross midnight without becoming a new daily obligation', () => {
  const late = Date.parse('2026-09-09T23:55:00Z');
  const s = restoreFocus(JSON.stringify(startFocus('Read', 15, late)))!;
  assert.equal(focusRemaining(s, late + 600000), 300000);
  assert.equal(s.startedAt, late);
});
test('session title is bounded and invalid start values are rejected', () => {
  assert.equal(startFocus('x'.repeat(900), 15, now).title.length, 500);
  assert.throws(() => startFocus(' ', 15, now));
  assert.throws(() => startFocus('Read', 0, now));
  assert.throws(() => startFocus('Read', 15, NaN));
});
test('clock rounds up the last fraction of a second and clamps expired time', () => {
  assert.equal(focusClock(1500000), '25:00');
  assert.equal(focusClock(1), '00:01');
  assert.equal(focusClock(-2000), '00:00');
});
