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

// Regression: the recommendation ledger showed the same sleep→HRV insight
// twice because its title copy was reworded ("→ 13% better HRV" to "lift your
// next-day HRV") and the ledger deduped on title text alone. dedupKey is
// derived from the finding's basis, not its wording, so it stays identical
// across a copy change even though the title itself does not.
test('dedupKey is stable across a sleep_impact title rewording', () => {
  const sleepImpact = {
    type: 'sleep_impact',
    evidence: {
      kind: 'sleep_impact', outcome: 'health:hrv', pct: 0.13,
      goodMean: 42.7, poorMean: 37.6, goodN: 18, poorN: 22,
    },
  };
  const acts = rankActions([sleepImpact]);
  assert.equal(acts.length, 1);
  assert.match(acts[0].title, /Best sleep nights/);
  assert.equal(acts[0].evidence.dedupKey, 'sleep_impact|health:hrv');
});

test('dedupKey distinguishes different outcomes for the same finding kind', () => {
  const hrv = rankActions([{ type: 'sleep_impact', evidence: { kind: 'sleep_impact', outcome: 'health:hrv', pct: 0.13, goodMean: 42.7, poorMean: 37.6, goodN: 18, poorN: 22 } }]);
  const focus = rankActions([{ type: 'sleep_impact', evidence: { kind: 'sleep_impact', outcome: 'wellbeing:focus', pct: 0.15, goodMean: 4.2, poorMean: 3.5, goodN: 18, poorN: 22 } }]);
  assert.notEqual(hrv[0].evidence.dedupKey, focus[0].evidence.dedupKey);
});
