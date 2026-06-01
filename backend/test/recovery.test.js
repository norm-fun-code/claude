const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/intelligence/recovery');

// Build a [{day,value}] series from an array of values.
function series(values) {
  return values.map((v, i) => ({ day: `2026-05-${String(i + 1).padStart(2, '0')}`, value: v }));
}
// A stable baseline of `n` days at `base`, then a final `last` value.
function baselineThen(base, n, last) {
  const vals = [];
  for (let i = 0; i < n; i++) vals.push(base + (i % 3 - 1) * 0.5); // tiny noise
  vals.push(last);
  return series(vals);
}

test('recoveryScore: high HRV + low RHR + good sleep → high score', () => {
  const seriesByKey = {
    'health:hrv': baselineThen(50, 30, 70),          // well above baseline → good
    'health:resting_hr': baselineThen(55, 30, 48),   // below baseline → good (inverted)
    'health:sleep_hours': baselineThen(7, 30, 8.5),  // above baseline → good
  };
  const rec = r.recoveryScore(seriesByKey);
  assert.ok(rec.score > 70, `expected high recovery, got ${rec.score}`);
  assert.equal(rec.inputs, 3);
  assert.equal(r.recoveryBand(rec.score).band, 'green');
});

test('recoveryScore: low HRV + high RHR → low score', () => {
  const seriesByKey = {
    'health:hrv': baselineThen(50, 30, 30),          // well below baseline → bad
    'health:resting_hr': baselineThen(55, 30, 68),   // above baseline → bad
    'health:sleep_hours': baselineThen(7, 30, 5),    // below baseline → bad
  };
  const rec = r.recoveryScore(seriesByKey);
  assert.ok(rec.score < 33, `expected low recovery, got ${rec.score}`);
  assert.equal(r.recoveryBand(rec.score).band, 'red');
});

test('recoveryScore: re-normalizes weights when inputs are missing', () => {
  const rec = r.recoveryScore({ 'health:hrv': baselineThen(50, 30, 70) });
  assert.equal(rec.inputs, 1);
  assert.ok(rec.score > 50); // HRV alone, above baseline
});

test('recoveryScore: null when no inputs', () => {
  assert.equal(r.recoveryScore({}), null);
  assert.equal(r.recoveryScore({ 'health:hrv': series([50, 51]) }), null); // too short
});

test('sleepDebt: accumulates shortfall vs need', () => {
  const s = series([6, 6, 6, 6, 6, 6, 6]); // 2h short each night × 7 = 14h raw, capped at 0 floor
  const d = r.sleepDebt(s, { need: 8, days: 7 });
  assert.ok(d.debtHours > 10, `expected real debt, got ${d.debtHours}`);
  assert.equal(d.avgHours, 6);
});

test('sleepDebt: well-rested → little/no debt', () => {
  const d = r.sleepDebt(series([8, 8.5, 8, 8, 9, 8, 8]), { need: 8, days: 7 });
  assert.equal(d.debtHours, 0);
});

test('sleepConsistency: steady sleep scores high, erratic scores low', () => {
  const steady = r.sleepConsistency(series([8, 8, 8, 8, 8, 8]), { minN: 5 });
  assert.ok(steady.score >= 95);
  const erratic = r.sleepConsistency(series([5, 9, 4, 10, 6, 9]), { minN: 5 });
  assert.ok(erratic.score < 50, `erratic should score low, got ${erratic.score}`);
});

test('trainingLoad: spike flagged high, steady is optimal', () => {
  // 28 days low, then a 7-day spike.
  const vals = [];
  for (let i = 0; i < 21; i++) vals.push(200);
  for (let i = 0; i < 7; i++) vals.push(600); // recent week 3x
  const load = r.trainingLoad({ 'health:active_energy': series(vals) });
  assert.equal(load.band, 'high');
  assert.ok(load.acwr > 1.5);

  const steadyVals = new Array(28).fill(300);
  const steady = r.trainingLoad({ 'health:active_energy': series(steadyVals) });
  assert.equal(steady.band, 'optimal');
});

test('computeHealthComposites: emits findings with evidence', () => {
  const seriesByKey = {
    'health:hrv': baselineThen(50, 30, 30),
    'health:resting_hr': baselineThen(55, 30, 68),
    'health:sleep_hours': series(new Array(7).fill(6)),
  };
  const findings = r.computeHealthComposites(seriesByKey);
  const types = findings.map((f) => f.type);
  assert.ok(types.includes('recovery'));
  assert.ok(types.includes('sleep_debt'));
  for (const f of findings) {
    assert.ok(f.title && f.detail && f.evidence && f.evidence.auto);
  }
});
