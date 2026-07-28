// "What explains this?" anomaly-context loop — pure-function unit tests for
// intelligence/anomalyContext.js's freshness/eligibility gate. No DB; see
// test/integration/anomaly-context.test.js for the full store/route/
// temporal-binding coverage that needs Postgres.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isFreshEnough, isEligibleForQuestion } = require('../src/intelligence/anomalyContext');

const TZ = 'America/New_York';
const NOW = new Date('2026-07-28T15:00:00-04:00'); // 2026-07-28, mid-afternoon ET

function anomalyEvidence(overrides = {}) {
  return {
    auto: true, kind: 'anomaly', metric: 'health:active_energy',
    date: '2026-07-27', unit: 'kcal', anomalyKey: 'anomaly:health:active_energy:2026-07-27',
    latest: 211, baselineMean: 552.9, baselineStd: 60, z: -5.7, n: 30,
    ...overrides,
  };
}

test('isFreshEnough: today and yesterday (local) both count as fresh', () => {
  assert.equal(isFreshEnough('2026-07-28', TZ, NOW), true);
  assert.equal(isFreshEnough('2026-07-27', TZ, NOW), true);
});

test('isFreshEnough: an observation from 3+ days ago is stale', () => {
  assert.equal(isFreshEnough('2026-07-24', TZ, NOW), false);
});

test('isFreshEnough: null/missing date is never fresh', () => {
  assert.equal(isFreshEnough(null, TZ, NOW), false);
  assert.equal(isFreshEnough(undefined, TZ, NOW), false);
});

// ── required: a meaningful completed-data anomaly offers the optional question ──
test('isEligibleForQuestion: a fresh anomaly with no prior row and no overlapping context is eligible', () => {
  const eligible = isEligibleForQuestion({ evidence: anomalyEvidence(), row: null, overlappingAssertions: [], tz: TZ, asOf: NOW });
  assert.equal(eligible, true);
});

// ── required: stale/incomplete source data does not prompt for an explanation ──
test('isEligibleForQuestion: a stale observation date is never eligible', () => {
  const eligible = isEligibleForQuestion({
    evidence: anomalyEvidence({ date: '2026-07-20', anomalyKey: 'anomaly:health:active_energy:2026-07-20' }),
    row: null, overlappingAssertions: [], tz: TZ, asOf: NOW,
  });
  assert.equal(eligible, false);
});

test('isEligibleForQuestion: non-anomaly evidence (e.g. a trend/correlation insight) is never eligible', () => {
  const eligible = isEligibleForQuestion({
    evidence: { kind: 'correlation', a: 'health:hrv', b: 'health:sleep_score' },
    row: null, overlappingAssertions: [], tz: TZ, asOf: NOW,
  });
  assert.equal(eligible, false);
});

// ── required: skip/answer persist and prevent repeated asking ──
test('isEligibleForQuestion: an active answered row suppresses re-asking', () => {
  const eligible = isEligibleForQuestion({
    evidence: anomalyEvidence(), row: { status: 'answered', retiredAt: null }, overlappingAssertions: [], tz: TZ, asOf: NOW,
  });
  assert.equal(eligible, false);
});

test('isEligibleForQuestion: an active skipped row suppresses re-asking', () => {
  const eligible = isEligibleForQuestion({
    evidence: anomalyEvidence(), row: { status: 'skipped', retiredAt: null }, overlappingAssertions: [], tz: TZ, asOf: NOW,
  });
  assert.equal(eligible, false);
});

// ── required: forgetting makes the anomaly re-askable ──
test('isEligibleForQuestion: a retired ("forgotten") row is fresh/re-askable again', () => {
  const eligible = isEligibleForQuestion({
    evidence: anomalyEvidence(), row: { status: 'answered', retiredAt: '2026-07-28T12:00:00Z' }, overlappingAssertions: [], tz: TZ, asOf: NOW,
  });
  assert.equal(eligible, true);
});

// ── required: existing linked context suppresses a duplicate question ──
test('isEligibleForQuestion: an already-overlapping resolved context event suppresses the question', () => {
  const eligible = isEligibleForQuestion({
    evidence: anomalyEvidence(), row: null,
    overlappingAssertions: [{ id: 'x', assertionType: 'event' }],
    tz: TZ, asOf: NOW,
  });
  assert.equal(eligible, false);
});

test('isEligibleForQuestion: missing anomalyKey is never eligible (no stable identity to bind to)', () => {
  const eligible = isEligibleForQuestion({
    evidence: anomalyEvidence({ anomalyKey: undefined }), row: null, overlappingAssertions: [], tz: TZ, asOf: NOW,
  });
  assert.equal(eligible, false);
});
