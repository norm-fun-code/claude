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

// Live bug found via a product review: a goal trending strongly toward its
// target got `on_track` from forecast.js's time-series model, while this
// SAME goal's raw snapshot progress (not yet 100%) still produced a
// leverage action reading "Close the gap ... This is off-track" — two
// detectors, same goal, contradictory verdicts, both in the same brief.
// Progress is 50% (well short of the 100% raw-progress cutoff) so the
// resulting leverage score clears rankActions' minScore threshold on its
// own — isolating the forecast-status behavior as the only variable under
// test, rather than accidentally testing the score-floor filter instead.
const goal = { id: 'g1', domain: 'wealth', metric: 'net_worth', title: 'Hit $500k', target_value: 500000, baseline_value: 400000 };
const latestByKey = { 'wealth:net_worth': 450000 }; // 50% of the way there by raw progress

test('an off-track-by-raw-progress goal is suppressed when the forecast says on_track', () => {
  const acts = rankActions([], { goals: [goal], latestByKey, forecastStatusByGoalId: { g1: 'on_track' } });
  assert.equal(acts.length, 0, 'the trend-aware forecast already says on_track — no contradictory "off-track" nudge should fire');
});

test('the same goal still produces the off-track action when no forecast (or a non-on_track one) exists', () => {
  const withoutForecast = rankActions([], { goals: [goal], latestByKey });
  assert.equal(withoutForecast.length, 1, 'unchanged fallback behavior when there is no forecast status to defer to');
  assert.match(withoutForecast[0].detail, /off-track/);

  const atRisk = rankActions([], { goals: [goal], latestByKey, forecastStatusByGoalId: { g1: 'at_risk' } });
  assert.equal(atRisk.length, 1, 'an at_risk (not on_track) forecast does not suppress the leverage action — the two verdicts agree here');
});

test('forecastStatusByGoalId is keyed by goal id — a different goal\'s on_track status does not suppress this one', () => {
  const acts = rankActions([], { goals: [goal], latestByKey, forecastStatusByGoalId: { 'some-other-goal': 'on_track' } });
  assert.equal(acts.length, 1, 'must not suppress based on an unrelated goal\'s forecast status');
});
