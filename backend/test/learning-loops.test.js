// The learning-loop closures (full-repo review, improvement #1): for years
// rankActions was a pure function of current findings — structurally blind to
// whether its own past advice worked. The recommendation ledger measured
// outcomes and experiments issued verdicts, but neither ever changed what got
// recommended. These tests pin the new behavior: measured "no effect" dampens
// then suppresses an action family; a REFUTED experiment kills its
// lever→outcome pair outright; a CONFIRMED one earns a confidence boost —
// and, critically, the interpretation of an outcome is ONE shared function so
// the brief's narration and the ranking can never disagree.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rankActions, basisKey } = require('../src/intelligence/leverage');
const { outcomeVerdict } = require('../src/store/recommendations');

// A confirmed sleep→HRV correlation that reliably produces one action.
const corrFinding = {
  type: 'correlation',
  evidence: { kind: 'correlation', a: 'health:sleep_hours', b: 'health:hrv', r: 0.6, confirmed: true },
};
// Its action's basis identity, for keying outcome history.
const corrDedupKey = () => {
  const [a] = rankActions([corrFinding]);
  return a.evidence.dedupKey;
};

test('outcomeVerdict: shared interpretation of delta + expected direction', () => {
  const t = (row) => outcomeVerdict(row);
  assert.equal(t({ outcome_measured_at: new Date(), outcome_delta: 2.1, expected_direction: 'up' }), 'helped');
  assert.equal(t({ outcome_measured_at: new Date(), outcome_delta: -1.2, expected_direction: 'up' }), 'no_effect');
  assert.equal(t({ outcome_measured_at: new Date(), outcome_delta: -0.8, expected_direction: 'down' }), 'helped');
  assert.equal(t({ outcome_measured_at: new Date(), outcome_delta: 0.8, expected_direction: 'down' }), 'no_effect');
  assert.equal(t({ outcome_measured_at: null, outcome_delta: 2 }), null, 'unmeasured = pending');
  assert.equal(t({ outcome_measured_at: new Date(), outcome_delta: null }), null, 'measured but no data = unjudgeable');
});

test('two measured no-effects (zero helps) halve the score; the action still surfaces', () => {
  const baseline = rankActions([corrFinding]);
  const key = corrDedupKey();
  const damped = rankActions([corrFinding], { outcomeHistory: { [key]: { helped: 0, noEffect: 2 } } });
  assert.equal(damped.length, 1, 'dampened, not gone');
  assert.ok(damped[0].evidence.score < baseline[0].evidence.score * 0.55, 'score roughly halved');
});

test('three measured no-effects (zero helps) suppress the action entirely', () => {
  const key = corrDedupKey();
  const out = rankActions([corrFinding], { outcomeHistory: { [key]: { helped: 0, noEffect: 3 } } });
  assert.equal(out.length, 0, 'a thrice-measured dud stops being recommended');
});

test('a repeatedly-helpful action gets boosted; a mixed record changes nothing', () => {
  const baseline = rankActions([corrFinding]);
  const key = corrDedupKey();
  const boosted = rankActions([corrFinding], { outcomeHistory: { [key]: { helped: 2, noEffect: 0 } } });
  assert.ok(boosted[0].evidence.score > baseline[0].evidence.score, 'proven help ranks higher');
  const mixed = rankActions([corrFinding], { outcomeHistory: { [key]: { helped: 1, noEffect: 1 } } });
  assert.equal(mixed[0].evidence.score, baseline[0].evidence.score, 'mixed evidence leaves the score alone');
});

test('outcome history for a DIFFERENT basis does not touch this action', () => {
  const baseline = rankActions([corrFinding]);
  const out = rankActions([corrFinding], { outcomeHistory: { 'trend|health:steps': { helped: 0, noEffect: 5 } } });
  assert.equal(out[0].evidence.score, baseline[0].evidence.score);
});

test('a REFUTED experiment verdict suppresses its correlation-derived action', () => {
  const out = rankActions([corrFinding], {
    experimentVerdicts: { 'health:sleep_hours|health:hrv': 'refuted' },
  });
  assert.equal(out.length, 0, 'formally ruled out on their own data — must not resurface as leverage');
});

test('a CONFIRMED experiment verdict boosts confidence (capped), and unrelated verdicts do nothing', () => {
  const baseline = rankActions([corrFinding]);
  const confirmed = rankActions([corrFinding], {
    experimentVerdicts: { 'health:sleep_hours|health:hrv': 'confirmed' },
  });
  assert.ok(confirmed[0].evidence.score > baseline[0].evidence.score, 'self-tested proof outranks correlation alone');
  assert.ok(confirmed[0].evidence.actionConfidence <= 0.95, 'confidence stays capped');

  const unrelated = rankActions([corrFinding], {
    experimentVerdicts: { 'habits:cold_shower|health:hrv': 'refuted' },
  });
  assert.equal(unrelated[0].evidence.score, baseline[0].evidence.score);
});

test('a refuted verdict also gates the habit_split path via HABIT_KEY normalization', () => {
  const habitSplit = {
    type: 'habit_split',
    evidence: {
      kind: 'habit_split', habit: 'Morning meditation', outcome: 'health:hrv', pct: 0.26,
      onMean: 58, offMean: 44, onN: 23, offN: 20,
    },
  };
  const baseline = rankActions([habitSplit]);
  assert.equal(baseline.length, 1, 'sanity: the split produces an action');
  const gated = rankActions([habitSplit], {
    experimentVerdicts: { 'habits:morning_tm|health:hrv': 'refuted' },
  });
  assert.equal(gated.length, 0, 'display-name habit bases must map back to canonical lever keys for gating');
});

test('with no learning inputs, ranking behavior is byte-identical to before (defaults are inert)', () => {
  const a = rankActions([corrFinding]);
  const b = rankActions([corrFinding], { outcomeHistory: {}, experimentVerdicts: {} });
  assert.deepEqual(a, b);
});
