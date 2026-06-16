const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scoreFindings, scoreFinding, signature, magnitude, noveltyFromAge,
} = require('../src/intelligence/curate');

// A strong, fresh anomaly should outrank a small trend even though trend ordering
// used to win categorically nowhere — proves importance × magnitude works.
test('a 4-sigma anomaly outranks a small trend of the same metric family', () => {
  const anomaly = {
    type: 'anomaly', title: 'HRV far below your usual', confidence: 0.9,
    domains: ['health'], evidence: { metric: 'health:hrv', z: -4.2 },
  };
  const trend = {
    type: 'trend', title: 'Steps up 22% over 7d', confidence: 0.5,
    domains: ['health'], evidence: { metric: 'health:steps', pctChange: 0.22 },
  };
  const ranked = scoreFindings([trend, anomaly]);
  assert.equal(ranked[0].type, 'anomaly');
});

// The user's headline complaint: a sleep lever should beat a raw trend of equal
// effect size purely because it's more actionable (higher importance).
test('sleep_impact outranks a trend of equal magnitude', () => {
  const sleep = {
    type: 'sleep_impact', title: 'Sleep → focus', confidence: 0.7,
    domains: ['health', 'wellbeing'], evidence: { pct: 0.3, driver: 'health:sleep_score', outcome: 'wellbeing:focus' },
  };
  const trend = {
    type: 'trend', title: 'HRV up 30%', confidence: 0.7,
    domains: ['health'], evidence: { metric: 'health:hrv', pctChange: 0.3 },
  };
  const ranked = scoreFindings([trend, sleep]);
  assert.equal(ranked[0].type, 'sleep_impact');
});

// Novelty: a brand-new correlation should rank above the SAME-strength one that's
// been confirmed for 45 days (the "stop re-showing it daily" requirement).
test('a fresh finding outranks an identical-strength stale one', () => {
  const fresh = {
    type: 'correlation', title: 'A ↔ B', confidence: 0.8,
    domains: ['health'], evidence: { r: 0.6, a: 'health:hrv', b: 'wellbeing:mood' },
  };
  const stale = {
    type: 'correlation', title: 'C ↔ D', confidence: 0.8,
    domains: ['health'], evidence: { r: 0.6, a: 'health:sleep_hours', b: 'wellbeing:energy' },
  };
  const now = new Date('2026-06-16T12:00:00Z');
  const firstSeenBySig = new Map([
    [signature(stale), new Date('2026-05-02T12:00:00Z')], // ~45 days old
    [signature(fresh), now],                               // seen today
  ]);
  const ranked = scoreFindings([stale, fresh], { firstSeenBySig, now });
  assert.equal(ranked[0].title, 'A ↔ B');
});

// Dedupe: a trend AND an anomaly on the SAME metric collapse to the stronger one.
test('redundant single-metric findings dedupe to the highest score', () => {
  const trend = {
    type: 'trend', title: 'HRV up 12%', confidence: 0.4,
    domains: ['health'], evidence: { metric: 'health:hrv', pctChange: 0.12 },
  };
  const anomaly = {
    type: 'anomaly', title: 'HRV above your usual', confidence: 0.9,
    domains: ['health'], evidence: { metric: 'health:hrv', z: 3.5 },
  };
  const ranked = scoreFindings([trend, anomaly]);
  const hrv = ranked.filter((f) => f.evidence.metric === 'health:hrv');
  assert.equal(hrv.length, 1);
  assert.equal(hrv[0].type, 'anomaly'); // the stronger survived
});

// Relational findings are never deduped against single-metric ones even when they
// share a metric — they're a distinct claim.
test('a correlation is not collapsed by a same-metric trend', () => {
  const trend = {
    type: 'trend', title: 'HRV up', confidence: 0.8,
    domains: ['health'], evidence: { metric: 'health:hrv', pctChange: 0.4 },
  };
  const corr = {
    type: 'correlation', title: 'HRV ↔ mood', confidence: 0.8,
    domains: ['health', 'wellbeing'], evidence: { r: 0.6, a: 'health:hrv', b: 'wellbeing:mood' },
  };
  const ranked = scoreFindings([trend, corr]);
  assert.equal(ranked.length, 2);
});

test('magnitude normalizers land in [0,1]', () => {
  assert.ok(magnitude({ type: 'trend', evidence: { pctChange: 2.0 } }) === 1);
  assert.ok(magnitude({ type: 'anomaly', evidence: { z: -8 } }) === 1);
  assert.ok(magnitude({ type: 'correlation', evidence: { r: -0.55 } }) > 0.5);
});

test('novelty decays from ~1 toward a 0.4 floor', () => {
  assert.ok(noveltyFromAge(0) > 0.99);
  assert.ok(noveltyFromAge(5) < noveltyFromAge(1));
  assert.ok(noveltyFromAge(365) >= 0.4 && noveltyFromAge(365) < 0.45);
  assert.equal(noveltyFromAge(null), 1.0); // unseen treated as new
});

test('scoreFinding annotates score and parts without mutating type/title', () => {
  const f = { type: 'trend', title: 'X', confidence: 0.5, evidence: { metric: 'health:hrv', pctChange: 0.3 } };
  const s = scoreFinding(f, 1.0);
  assert.equal(s.type, 'trend');
  assert.ok(s._score > 0 && s._score <= 1);
  assert.ok(s._scoreParts.importance === 0.5);
});
