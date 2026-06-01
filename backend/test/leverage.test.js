const test = require('node:test');
const assert = require('node:assert/strict');
const { rankActions } = require('../src/intelligence/leverage');

const corr = (a, b, r, extra = {}) => ({
  type: 'correlation',
  evidence: { kind: 'correlation', a, b, r, confirmed: true, ...extra },
});

test('lever advice respects an outcome where lower is better (resting HR)', () => {
  // More sleep ↔ lower resting HR (negative r). RHR is good when DOWN, so the
  // right advice is to get MORE sleep — not less.
  const acts = rankActions([corr('health:sleep_hours', 'health:resting_hr', -0.6, { lag: 1 })]);
  assert.equal(acts.length, 1);
  assert.match(acts[0].title, /Resting HR/);
  assert.match(acts[0].title, /more sleep/);
});

test('lever advice for an outcome where higher is better (focus)', () => {
  const acts = rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6)]);
  assert.match(acts[0].title, /Focus/);
  assert.match(acts[0].title, /more sleep/);
});

test('habit levers can now produce actions (widened matrix)', () => {
  // Morning meditation ↔ mood (positive). Habits are valid levers now.
  const acts = rankActions([corr('habits:morning_tm', 'wellbeing:mood', 0.55)]);
  assert.ok(acts.length >= 1);
  assert.match(acts[0].title, /Mood/);
});

test('unconfirmed correlations do not become actions', () => {
  const acts = rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6, { confirmed: false })]);
  assert.equal(acts.length, 0);
});
