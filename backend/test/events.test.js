const test = require('node:test');
const assert = require('node:assert/strict');
const { fromHealthAnomaly } = require('../src/intelligence/events');
const { judge } = require('../src/intelligence/attention');

const cfg = { metric: 'resting_hr' };

function policyContext() {
  return {
    quiet: false,
    budget: { limit: 4, usedToday: 0 },
    criticalBudget: { limit: 1, usedToday: 0 },
    recentKeys: new Set(), noveltyByKey: new Set(), consentGrants: new Set(),
    beliefMultipliers: new Map(), activeGoalSubjects: new Set(),
    activeChapterSubjects: new Set(), openCommitmentSubjects: new Set(),
    capacity: null, questionBudgetLeft: 1,
  };
}

test('a single health anomaly is never marked critical and confidence reflects baseline coverage', () => {
  const sparse = fromHealthAnomaly({
    cfg, a: { z: 4, n: 8 }, asOf: new Date('2026-07-30T12:00:00Z'), title: 'Resting HR is up', body: 'x',
  });
  const established = fromHealthAnomaly({
    cfg, a: { z: 4, n: 28 }, asOf: new Date('2026-07-30T12:00:00Z'), title: 'Resting HR is up', body: 'x',
  });

  assert.equal(sparse.critical, false);
  assert.equal(established.critical, false);
  assert.equal(sparse.signal.confidence, 0.6);
  assert.equal(established.signal.confidence, 0.75);
  assert.equal(established.urgencyHint, 0.9, 'an extreme outlier may be timely without being called critical');
});

test('only an extreme anomaly can clear the normal alert bar; it never uses the critical bypass', () => {
  const moderate = fromHealthAnomaly({
    cfg, a: { z: 2.5, n: 24 }, asOf: new Date('2026-07-30T12:00:00Z'), title: 'Resting HR is up', body: 'x',
  });
  const extreme = fromHealthAnomaly({
    cfg, a: { z: 4, n: 24 }, asOf: new Date('2026-07-30T12:00:00Z'), title: 'Resting HR is up', body: 'x',
  });
  const moderateDecision = judge(moderate, policyContext());
  const extremeDecision = judge(extreme, policyContext());

  assert.equal(moderateDecision.disposition, 'add_to_brief');
  assert.equal(extremeDecision.disposition, 'notify_now');
  assert.equal(extremeDecision.gates.critical_override, undefined);
});
