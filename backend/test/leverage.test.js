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

// Bug: fromSleepImpact's detail used "across 18+22 days" — developer
// shorthand, not readable cohort language — and the same defect as
// analyze.js's computeSleepImpact (the two sleep_impact copy sites).
test('fromSleepImpact detail uses clear cohort language, not "N+N days" shorthand', () => {
  const acts = rankActions([{
    type: 'sleep_impact',
    evidence: { kind: 'sleep_impact', outcome: 'health:hrv', pct: 0.13, goodMean: 42.7, poorMean: 37.6, goodN: 18, poorN: 22 },
  }]);
  assert.equal(acts.length, 1);
  assert.doesNotMatch(acts[0].detail, /\d+\+\d+\s*days/, 'must not use the "N+N days" developer shorthand');
  assert.match(acts[0].detail, /across 40 comparison days/, 'total (18+22) must be computed, not hard-coded');
  assert.match(acts[0].detail, /18 best-sleep nights/);
  assert.match(acts[0].detail, /22 worst-sleep nights/);
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

// Audit fix: a statistically CONFIRMED correlation (split-half stable) is
// still an OBSERVATIONAL pattern, not a proven cause — fromCorrelation must
// never phrase it as an imperative "do X to move the needle" recommendation.
test('fromCorrelation: never uses "move the needle" or unhedged "confirmed" causal-recommendation framing', () => {
  const acts = rankActions([corr('habits:morning_tm', 'wellbeing:mood', 0.55)]);
  assert.ok(acts.length >= 1, 'sanity: expected a leverage action from a confirmed correlation');
  const detail = acts[0].detail.toLowerCase();
  assert.ok(!detail.includes('move the needle'), `detail must not use imperative "move the needle" framing: ${detail}`);
  assert.ok(!/\bconfirmed in your data\b/.test(detail), `detail must not claim causal "confirmed" status: ${detail}`);
  assert.match(detail, /observed association|not a proven cause|worth (deliberately )?testing/, 'must use tentative, observational framing');
});

// Context Understanding Layer, scenario 6 + harden-pass item 4 (preference
// POLARITY): "don't recommend X" (avoid) must exclude a matching candidate,
// but "I prefer X" (prefer) must BOOST the identical candidate instead — the
// bug an independent audit caught was that every preference, regardless of
// what the user actually said, was treated as an exclusion. See
// intelligence/context-resolver.js's 'action_type'/'changes_priority'
// relations (direction carries the polarity) and analyze.js's rankActions call.
function matchingTargetIdFor(title) {
  return title.toLowerCase().split(/\s+/).slice(0, 3).join('_');
}

test('an "avoid" preference excludes a matching candidate action', () => {
  const withoutPref = rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6)]);
  assert.ok(withoutPref.length >= 1, 'sanity: the candidate exists without a preference');
  const preferences = [{ targetId: matchingTargetIdFor(withoutPref[0].title), relationship: 'changes_priority', direction: 'avoid' }];
  const withPref = rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6)], { preferences });
  assert.equal(withPref.length, 0, 'an "avoid" preference must exclude the matching candidate, not merely deprioritize it');
});

test('a "prefer" preference on the SAME target BOOSTS the matching candidate instead of excluding it', () => {
  const withoutPref = rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6)]);
  assert.ok(withoutPref.length >= 1, 'sanity: the candidate exists without a preference');
  const baseScore = withoutPref[0].confidence; // rankActions maps score -> finding.confidence

  const preferences = [{ targetId: matchingTargetIdFor(withoutPref[0].title), relationship: 'changes_priority', direction: 'prefer' }];
  const withPref = rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6)], { preferences });
  assert.equal(withPref.length, 1, 'a "prefer" preference must NEVER exclude the matching candidate (this was the reported bug)');
  assert.ok(withPref[0].confidence > baseScore, `expected a boosted score (${withPref[0].confidence}) to exceed the unboosted score (${baseScore})`);
});

test('a "require" preference on the SAME target boosts MORE STRONGLY than "prefer"', () => {
  const preferTarget = matchingTargetIdFor(rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6)])[0].title);
  const preferred = rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6)], {
    preferences: [{ targetId: preferTarget, relationship: 'changes_priority', direction: 'prefer' }],
  });
  const required = rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6)], {
    preferences: [{ targetId: preferTarget, relationship: 'changes_priority', direction: 'require' }],
  });
  assert.ok(required[0].confidence > preferred[0].confidence, 'a "require" (hard rule) must boost more than an ordinary "prefer"');
});

test('a "neutral"/unrecognized-direction preference does not alter ranking at all', () => {
  const withoutPref = rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6)]);
  const preferences = [{ targetId: matchingTargetIdFor(withoutPref[0].title), relationship: 'changes_priority', direction: 'neutral' }];
  const withPref = rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6)], { preferences });
  assert.equal(withPref.length, withoutPref.length);
  assert.equal(withPref[0].confidence, withoutPref[0].confidence, 'neutral must leave the score completely unchanged');
});

test('a preference that does not match any candidate leaves the ranking untouched', () => {
  const preferences = [{ targetId: 'evening_workouts', relationship: 'changes_priority', direction: 'avoid' }];
  const acts = rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6)], { preferences });
  assert.ok(acts.length >= 1, 'an unrelated preference must not suppress an unrelated candidate');
});

test('no preferences at all (default []) behaves exactly as before — backward compatible', () => {
  const acts = rankActions([corr('health:sleep_hours', 'wellbeing:focus', 0.6)]);
  assert.ok(acts.length >= 1);
});
