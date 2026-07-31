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
  // HRV level + HRV trend + RHR + sleep = 4 inputs (HRV contributes both a
  // level-rank and a direction/trend component).
  assert.equal(rec.inputs, 4);
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
  // HRV alone still yields two components (level + trend), and the weights
  // re-normalize over just those, so a strong night reads high.
  const rec = r.recoveryScore({ 'health:hrv': baselineThen(50, 30, 70) });
  assert.equal(rec.inputs, 2);
  assert.ok(rec.score > 50); // HRV alone, above baseline
});

test('trendScore: rising vs last week > 50, falling < 50, flat ~50', () => {
  // 7-day baseline near 50, then today's value moves the trend.
  assert.ok(r.trendScore(baselineThen(50, 10, 65)) > 50, 'rising HRV should score above 50');
  assert.ok(r.trendScore(baselineThen(50, 10, 35)) < 50, 'falling HRV should score below 50');
  const flat = r.trendScore(baselineThen(50, 10, 50));
  assert.ok(flat >= 45 && flat <= 55, `flat should be ~50, got ${flat}`);
  // Not enough history → null (graceful; weight just drops out).
  assert.equal(r.trendScore(series([50, 51, 52])), null);
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
  assert.match(load.note, /if your recovery or how you feel/i);
  assert.doesNotMatch(load.note, /injury|tissue adaptation/i);

  const steadyVals = new Array(28).fill(300);
  const steady = r.trainingLoad({ 'health:active_energy': series(steadyVals) });
  assert.equal(steady.band, 'optimal');
  assert.equal(steady.note, 'Training load is close to your recent range.');
});

test('sleep surplus: slept MORE than Eight Sleep need → surplus, not debt', () => {
  // 8h14m last night vs 7h44m need — the exact case that was mislabeled "41m debt".
  const seriesByKey = {
    'health:hrv': baselineThen(50, 30, 55),
    'health:resting_hr': baselineThen(55, 30, 52),
    'health:sleep_hours': baselineThen(8.0, 30, 8 + 14 / 60),
    'health:sleep_need': series(new Array(31).fill(7 + 44 / 60)),
  };
  const findings = r.computeHealthComposites(seriesByKey);
  const sd = findings.find((f) => f.type === 'sleep_debt');
  assert.ok(sd, 'expected a sleep_debt-type finding');
  assert.match(sd.title, /surplus/i);
  assert.equal(sd.evidence.kind, 'sleep_surplus');
  assert.doesNotMatch(sd.detail, /\bdebt\b/i); // detail must not contradict the headline
});

test('sleep debt: slept LESS than need → debt, headline matches detail', () => {
  const seriesByKey = {
    'health:hrv': baselineThen(50, 30, 48),
    'health:resting_hr': baselineThen(55, 30, 58),
    'health:sleep_hours': baselineThen(7, 30, 6.5),
    'health:sleep_need': series(new Array(31).fill(7 + 44 / 60)),
  };
  const findings = r.computeHealthComposites(seriesByKey);
  const sd = findings.find((f) => f.type === 'sleep_debt');
  assert.ok(sd && /debt/i.test(sd.title));
  assert.match(sd.detail, /below your need/i);
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

test('strainSynthesis: paired recovery changes remain observational, not an overreaching diagnosis', () => {
  const hrv = series(Array.from({ length: 14 }, (_, i) => 60 - i * 1.2)); // falling
  const rhr = series(Array.from({ length: 14 }, (_, i) => 50 + i * 0.6)); // rising
  const f = r.strainSynthesis({ 'health:hrv': hrv, 'health:resting_hr': rhr });
  assert.ok(f, 'expected a strain finding');
  assert.equal(f.type, 'strain');
  assert.deepEqual(f.evidence.signals.sort(), ['hrv', 'rhr']);
  assert.match(f.title, /worth watching/i);
  assert.match(f.detail, /not a diagnosis/i);
  assert.doesNotMatch(f.detail, /parasympathetic|overreaching|let HRV climb/i);
  assert.equal(f.evidence.evidenceTier, 'direct_observation');
  assert.match(f.evidence.uncertainty, /does not identify a cause/i);
  assert.ok(f.confidence < 0.7, 'two trends should not present as a high-confidence diagnosis');
  assert.ok(f.evidence.severity > 0 && f.evidence.severity <= 1);
});

test('strainSynthesis: a single signal is not enough (no false overreaching flag)', () => {
  const hrv = series(Array.from({ length: 14 }, (_, i) => 60 - i * 1.2)); // falling
  const rhr = series(Array.from({ length: 14 }, () => 50));               // flat
  assert.equal(r.strainSynthesis({ 'health:hrv': hrv, 'health:resting_hr': rhr }), null);
});

test('strainSynthesis: a single bad night does not trigger overreaching', () => {
  // 13 steady days + one alcohol-style HRV crash — a 7-day mean shift, not a trend.
  const hrv = series([...Array(13).fill(55), 24]);
  const rhr = series([...Array(13).fill(50), 62]);
  assert.equal(r.strainSynthesis({ 'health:hrv': hrv, 'health:resting_hr': rhr }), null);
});

test('fitnessFinding: features VO₂ max with current value and quarter trajectory', () => {
  const vo2 = series(Array.from({ length: 30 }, (_, i) => 47 + i * 0.03)); // slowly rising
  const f = r.fitnessFinding({ 'health:vo2_max': vo2 });
  assert.ok(f, 'expected a fitness finding');
  assert.equal(f.type, 'fitness');
  assert.match(f.title, /VO₂ max 4[78]/);
  assert.match(f.detail, /longevity|lifespan|long-term health/i);
  assert.equal(f.evidence.metric, 'health:vo2_max');
  assert.ok(f.evidence.per90 > 0, 'rising VO₂ max should have positive quarter slope');
});

test('fitnessFinding: returns null without VO₂ max data', () => {
  assert.equal(r.fitnessFinding({ 'health:hrv': series([50, 51, 52]) }), null);
});

// Live bug found via a product screenshot review: HealthCard showed 44.7 (a
// live device VO2 reading, pushed to the spine on every Health tab open) while
// the "fitness" insight card showed 43.7 (frozen at whatever the last nightly
// analyze() run computed) — same metric, two numbers, same tab. Root cause:
// fitnessFinding()'s title/detail formatting was inlined, so there was no way
// to re-render it with a fresher "current" without duplicating the prose
// template. formatFitnessFinding() is that extracted, shared piece — this
// locks in that it renders identically whether called from fitnessFinding()
// (the batch path) or briefing.js's live-freshen step (see
// briefing-health-insights-freshen.test.js for that integration test).
test('formatFitnessFinding: matches fitnessFinding()\'s own formatting exactly', () => {
  const vo2 = series(Array.from({ length: 30 }, (_, i) => 47 + i * 0.03));
  const viaFinding = r.fitnessFinding({ 'health:vo2_max': vo2 });
  const viaFormatter = r.formatFitnessFinding(viaFinding.evidence.current, viaFinding.evidence.per90);
  assert.equal(viaFormatter.title, viaFinding.title);
  assert.equal(viaFormatter.detail, viaFinding.detail);
});

test('formatFitnessFinding: a different current value produces a different title/detail (the actual freshen behavior)', () => {
  const stale = r.formatFitnessFinding(43.7, 2.1);
  const fresh = r.formatFitnessFinding(44.7, 2.1);
  assert.match(stale.title, /43\.7/);
  assert.match(fresh.title, /44\.7/);
  assert.notEqual(stale.title, fresh.title);
  assert.match(fresh.detail, /44\.7/);
});

test('formatFitnessFinding: holds steady below the 0.5pt/quarter noise floor, same as fitnessFinding()', () => {
  const { title } = r.formatFitnessFinding(45, 0.2);
  assert.doesNotMatch(title, /rising|declining/);
  assert.match(title, /^VO₂ max 45$/);
});

test('selfReportRecovery: quality-weighted proxy with sensible bands', () => {
  // A solid self-reported night → green-ish.
  const good = r.selfReportRecovery({ quality: 4, hours: 7, need: 7.7 });
  assert.ok(good && good.score >= 63, `4/5, 7h should land green-ish, got ${good && good.score}`);
  // A poor short night → low.
  const poor = r.selfReportRecovery({ quality: 2, hours: 5, need: 7.7 });
  assert.ok(poor.score < 50, `2/5, 5h should be low, got ${poor.score}`);
  // Quality dominates: a 5/5 outranks a 3/5 at equal hours.
  assert.ok(r.selfReportRecovery({ quality: 5, hours: 7 }).score > r.selfReportRecovery({ quality: 3, hours: 7 }).score);
  // Never pegs at 0/100.
  assert.ok(r.selfReportRecovery({ quality: 1, hours: 3 }).score >= 5);
  assert.ok(r.selfReportRecovery({ quality: 5, hours: 10 }).score <= 98);
  // Bad input → null.
  assert.equal(r.selfReportRecovery({ quality: 0 }), null);
  assert.equal(r.selfReportRecovery({ quality: 6 }), null);
  assert.equal(r.selfReportRecovery({}), null);
  // Hours optional — quality alone still scores.
  assert.ok(r.selfReportRecovery({ quality: 4 }).score > 0);
});
