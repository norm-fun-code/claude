// Precedent engine — the gates are the feature.
//
// This module's whole claim is "you have been here before, and here is what
// happened next." That claim is worthless (worse: actively misleading) if it
// can be produced from thin evidence, from days that were not actually
// similar, from a lopsided comparison, or from a baseline that peeked at data
// which had not happened yet. So the tests below are overwhelmingly about the
// conditions under which the engine must REFUSE to say anything — the same
// bar findRiskEvidence holds in brain/todayCommandCenter.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPrecedent,
  causalZScores,
  gowerDistance,
  rankPrecedents,
  splitByLever,
  describeState,
  addDays,
  MIN_PRECEDENTS,
  MIN_ARM,
} = require('../src/intelligence/precedent');

// --- fixtures ------------------------------------------------------------

/** A realistic morning vector, in the z-scored shape the engine consumes. */
function vec({ hrv = 0, rhr = 0, sleep = 0, score = null, prevLoad = null } = {}) {
  const v = { 'health:hrv': hrv, 'health:resting_hr': rhr, 'health:sleep_hours': sleep };
  if (score != null) v['health:sleep_score'] = score;
  if (prevLoad != null) v['prev:active_energy'] = prevLoad;
  return v;
}

/**
 * A full synthetic world: `n` past days that are all near-identical to today
 * (so they qualify as precedents), each with a recovery score, a next-day
 * recovery score, and a day-load. Callers override individual days to build
 * the specific situation under test.
 */
function world({ today = '2026-09-08', n = 10, startDay = '2026-06-01' } = {}) {
  const vectorsByDay = { [today]: vec({ hrv: -1.2, rhr: 0.9, sleep: -1.1, score: -0.8 }) };
  const rawByDay = { [today]: { 'health:hrv': 41, 'health:resting_hr': 58, 'health:sleep_hours': 5.8 } };
  const recoveryByDay = {};
  const leverByDay = {};
  for (let i = 0; i < n; i++) {
    const day = addDays(startDay, i * 3);
    // Jitter well inside the similarity gate so every one of these is a
    // genuine precedent — the tests that need a NON-precedent say so.
    const j = (i % 3) * 0.05;
    vectorsByDay[day] = vec({ hrv: -1.2 + j, rhr: 0.9 - j, sleep: -1.1 + j, score: -0.8 });
    recoveryByDay[day] = 55;
    recoveryByDay[addDays(day, 1)] = 55;
    leverByDay[day] = 500;
  }
  return { today, vectorsByDay, rawByDay, recoveryByDay, leverByDay };
}

// --- causal baselines ----------------------------------------------------

test('causalZScores never scores a day against data from its own future', () => {
  // A series that is flat at 50 for 20 days, then jumps to 100 forever. If the
  // baseline leaked future data, the flat days would be scored as "low"
  // against a mean pulled up by the later jump. Causally, they are exactly
  // average — the jump had not happened yet.
  const byDay = {};
  for (let i = 0; i < 20; i++) byDay[addDays('2026-01-01', i)] = 50 + (i % 2); // tiny spread so sd > 0
  for (let i = 20; i < 40; i++) byDay[addDays('2026-01-01', i)] = 100;

  const z = causalZScores(byDay, { baselineDays: 28, minObs: 10 });

  const lastFlatDay = addDays('2026-01-01', 19);
  assert.ok(Math.abs(z[lastFlatDay]) < 1.5, `a flat day scored ${z[lastFlatDay]} — future data leaked into its baseline`);
  const firstJumpDay = addDays('2026-01-01', 20);
  assert.ok(z[firstJumpDay] > 5, 'the jump day should read as extreme against its own past');
});

test('causalZScores yields nothing for a day with too little history behind it', () => {
  const byDay = {};
  for (let i = 0; i < 6; i++) byDay[addDays('2026-03-01', i)] = 40 + i;
  const z = causalZScores(byDay, { baselineDays: 28, minObs: 10 });
  assert.deepEqual(z, {}, 'a feature with a thin baseline must be ABSENT, never imputed');
});

test('causalZScores yields nothing when the baseline has no spread', () => {
  // A perfectly constant metric has no scale — "1.4 above average" is
  // meaningless when average never varies. Dividing by zero sd would produce
  // Infinity and poison every distance it touches.
  const byDay = {};
  for (let i = 0; i < 30; i++) byDay[addDays('2026-03-01', i)] = 42;
  const z = causalZScores(byDay, { baselineDays: 28, minObs: 10 });
  assert.deepEqual(z, {});
});

// --- ragged-vector distance ---------------------------------------------

test('gowerDistance drops a feature only one day has, rather than scoring it as agreement', () => {
  const a = vec({ hrv: 1, rhr: 1, sleep: 1, score: 2 });
  const b = vec({ hrv: 1, rhr: 1, sleep: 1 }); // no sleep score at all
  const g = gowerDistance(a, b);
  assert.equal(g.distance, 0, 'the two days agree on everything they SHARE');
  assert.equal(g.sharedCount, 3, 'the unmatched feature must not be counted as shared');
});

test('gowerDistance returns null when two days share no feature', () => {
  assert.equal(gowerDistance({ 'health:hrv': 1 }, { 'health:sleep_score': 1 }), null);
});

test('gowerDistance is bounded — one wildly different feature cannot dominate without limit', () => {
  const g = gowerDistance(vec({ hrv: 0, rhr: 0, sleep: 0 }), vec({ hrv: 40, rhr: 0, sleep: 0 }));
  assert.ok(g.distance <= 1 && g.distance > 0);
});

// --- who counts as a precedent ------------------------------------------

test('rankPrecedents rejects a day that overlaps on too few features to be comparable', () => {
  const todayVector = vec({ hrv: -1.2, rhr: 0.9, sleep: -1.1 });
  const historyVectors = {
    // Identical on the ONE metric they share — but one metric is not similarity.
    '2026-05-02': { 'health:hrv': -1.2 },
    '2026-05-03': { 'health:hrv': -1.2, 'health:resting_hr': 0.9 },
  };
  assert.deepEqual(rankPrecedents({ todayVector, historyVectors }), []);
});

test('rankPrecedents rejects a day that is simply not similar', () => {
  const todayVector = vec({ hrv: -1.5, rhr: 1.2, sleep: -1.4 });
  const historyVectors = { '2026-05-02': vec({ hrv: 1.6, rhr: -1.3, sleep: 1.5 }) };
  assert.deepEqual(rankPrecedents({ todayVector, historyVectors }), [], 'an opposite morning is not a precedent');
});

test('rankPrecedents orders by similarity and breaks ties toward the more recent day', () => {
  const todayVector = vec({ hrv: -1, rhr: 1, sleep: -1 });
  const historyVectors = {
    '2026-05-02': vec({ hrv: -1, rhr: 1, sleep: -1 }),
    '2026-07-02': vec({ hrv: -1, rhr: 1, sleep: -1 }),
    '2026-06-02': vec({ hrv: -1.3, rhr: 1.2, sleep: -0.8 }),
  };
  const ranked = rankPrecedents({ todayVector, historyVectors });
  assert.equal(ranked[0].day, '2026-07-02', 'exact ties should surface the more recent life');
  assert.equal(ranked[1].day, '2026-05-02');
  assert.equal(ranked[2].day, '2026-06-02');
});

// --- the comparison, and when it must be withheld ------------------------

test('splitByLever compares the two arms when both are genuinely supported', () => {
  const precedents = Array.from({ length: 8 }, (_, i) => ({ day: addDays('2026-04-01', i) }));
  const leverByDay = {};
  const outcomeByDay = {};
  precedents.forEach((p, i) => {
    leverByDay[p.day] = i < 4 ? 200 : 900;   // four light days, four hard ones
    outcomeByDay[p.day] = i < 4 ? +8 : -4;
  });
  const split = splitByLever(precedents, { leverByDay, outcomeByDay });
  assert.equal(split.lighter.n, 4);
  assert.equal(split.harder.n, 4);
  assert.equal(split.lighter.meanNextDayDelta, 8);
  assert.equal(split.harder.meanNextDayDelta, -4);
});

test('splitByLever withholds the comparison when one arm is too thin', () => {
  const precedents = Array.from({ length: 8 }, (_, i) => ({ day: addDays('2026-04-01', i) }));
  const leverByDay = {};
  const outcomeByDay = {};
  precedents.forEach((p, i) => {
    leverByDay[p.day] = i === 0 ? 200 : 900; // 1 vs 7 — no comparison to make
    outcomeByDay[p.day] = i === 0 ? +9 : -5;
  });
  assert.equal(splitByLever(precedents, { leverByDay, outcomeByDay }), null);
});

test('splitByLever withholds the comparison when the gap is inside the noise floor', () => {
  const precedents = Array.from({ length: 8 }, (_, i) => ({ day: addDays('2026-04-01', i) }));
  const leverByDay = {};
  const outcomeByDay = {};
  precedents.forEach((p, i) => {
    leverByDay[p.day] = i < 4 ? 200 : 900;
    outcomeByDay[p.day] = i < 4 ? 1 : 0; // a 1-point difference proves nothing
  });
  assert.equal(splitByLever(precedents, { leverByDay, outcomeByDay }), null);
});

test('splitByLever withholds the comparison when every day carried the same load', () => {
  const precedents = Array.from({ length: 8 }, (_, i) => ({ day: addDays('2026-04-01', i) }));
  const leverByDay = {};
  const outcomeByDay = {};
  precedents.forEach((p, i) => { leverByDay[p.day] = 500; outcomeByDay[p.day] = i < 4 ? 9 : -9; });
  assert.equal(
    splitByLever(precedents, { leverByDay, outcomeByDay }), null,
    'with no variation in what was done, an outcome difference cannot be attributed to it'
  );
});

test('splitByLever ignores precedents whose next-day outcome was never recorded', () => {
  const precedents = Array.from({ length: 8 }, (_, i) => ({ day: addDays('2026-04-01', i) }));
  const leverByDay = {};
  const outcomeByDay = {};
  precedents.forEach((p, i) => {
    leverByDay[p.day] = i < 4 ? 200 : 900;
    if (i !== 0 && i !== 4) outcomeByDay[p.day] = i < 4 ? +8 : -4; // two days never got a reading
  });
  const split = splitByLever(precedents, { leverByDay, outcomeByDay });
  assert.equal(split.lighter.n, 3);
  assert.equal(split.harder.n, 3);
  assert.ok(!split.lighter.days.includes(addDays('2026-04-01', 0)));
});

// --- the whole projection ------------------------------------------------

test('buildPrecedent returns null rather than a weak claim when precedents are too few', () => {
  const w = world({ n: MIN_PRECEDENTS - 1 });
  assert.equal(buildPrecedent(w), null);
});

test('buildPrecedent returns null when today itself could not be scored', () => {
  const w = world({ n: 10 });
  delete w.vectorsByDay[w.today];
  assert.equal(buildPrecedent(w), null);
});

test('buildPrecedent never treats yesterday as a precedent — its outcome is still today', () => {
  const w = world({ n: 10 });
  const yesterday = addDays(w.today, -1);
  w.vectorsByDay[yesterday] = vec({ hrv: -1.2, rhr: 0.9, sleep: -1.1, score: -0.8 });
  w.recoveryByDay[yesterday] = 55;
  w.leverByDay[yesterday] = 500;
  const out = buildPrecedent(w);
  assert.ok(!out.precedents.some((p) => p.day === yesterday), 'yesterday has no completed "next day" yet');
});

test('buildPrecedent reports a real, checkable precedent set', () => {
  const out = buildPrecedent(world({ n: 10 }));
  assert.equal(out.count, 10);
  assert.equal(out.asOf, '2026-09-08');
  assert.ok(out.earliest < out.latest, 'the window the evidence spans must be stated');
  for (const p of out.precedents) {
    assert.match(p.day, /^\d{4}-\d{2}-\d{2}$/, 'every precedent names a real date the user can check');
    assert.ok(p.similarity >= 80 && p.similarity <= 100);
    assert.ok(p.day < out.asOf, 'a precedent is always in the past');
  }
});

test('buildPrecedent surfaces the comparison when the history genuinely supports one', () => {
  const w = world({ n: 10 });
  // Half these mornings were followed by a light day, half by a hard one, and
  // recovery moved differently after each.
  Object.keys(w.leverByDay).forEach((day, i) => {
    w.leverByDay[day] = i % 2 === 0 ? 180 : 950;
    w.recoveryByDay[addDays(day, 1)] = i % 2 === 0 ? 63 : 49; // from 55: +8 / -6
  });
  const out = buildPrecedent(w);
  assert.ok(out.comparison, 'a supported comparison should be reported');
  assert.ok(out.comparison.lighter.n >= MIN_ARM && out.comparison.harder.n >= MIN_ARM);
  assert.ok(
    out.comparison.lighter.meanNextDayDelta > out.comparison.harder.meanNextDayDelta,
    'the arms must carry their real measured direction'
  );
});

test('buildPrecedent still returns the precedent set when the comparison is withheld', () => {
  // Same-load days everywhere: enough precedent to say "you have been here",
  // not enough variation to say "and this is what changed it".
  const out = buildPrecedent(world({ n: 10 }));
  assert.equal(out.comparison, null);
  assert.equal(out.count, 10, 'the precedent set is independently useful and must survive');
});

test('describeState leads with what is most unusual about today, with real values', () => {
  const state = describeState(
    vec({ hrv: -1.9, rhr: 0.3, sleep: -0.7 }),
    { 'health:hrv': 38.2, 'health:resting_hr': 55, 'health:sleep_hours': 6.1 }
  );
  assert.equal(state[0].key, 'health:hrv', 'the most extreme feature leads');
  assert.equal(state[0].value, 38.2, 'the observed value travels with the z-score so it can be checked');
  assert.equal(state[0].direction, 'below');
});

test('buildPrecedent states the gates it applied, so the claim is auditable', () => {
  const out = buildPrecedent(world({ n: 10 }));
  assert.equal(out.evidence.minSimilarity, 0.8);
  assert.equal(out.evidence.baselineDays, 28);
  assert.equal(out.evidence.leverMetric, 'health:active_energy');
});
