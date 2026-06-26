const test = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../src/intelligence/stats');

test('linearFit recovers slope/intercept of a clean line', () => {
  const fit = stats.linearFit([0, 2, 4, 6, 8]);
  assert.ok(fit);
  assert.equal(Math.round(fit.slope * 1000) / 1000, 2);
  assert.equal(Math.round(fit.intercept * 1000) / 1000, 0);
  assert.ok(fit.residualStd < 1e-9, 'no residual on a perfect line');
});

test('linearFit reports residual spread on noisy data', () => {
  const fit = stats.linearFit([0, 3, 3, 9, 8]);
  assert.ok(fit.residualStd > 0);
});

test('linearFit returns null when underdetermined', () => {
  assert.equal(stats.linearFit([5]), null);
});

test('normalCdf matches known quantiles', () => {
  assert.ok(Math.abs(stats.normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(stats.normalCdf(1.959964) - 0.975) < 1e-3);
  assert.ok(Math.abs(stats.normalCdf(-1.959964) - 0.025) < 1e-3);
  // Symmetry: Φ(z) + Φ(-z) = 1
  assert.ok(Math.abs(stats.normalCdf(0.7) + stats.normalCdf(-0.7) - 1) < 1e-6);
});

test('normalCdf saturates at the tails', () => {
  assert.ok(stats.normalCdf(40) > 0.9999);
  assert.ok(stats.normalCdf(-40) < 0.0001);
  assert.equal(stats.normalCdf(Infinity), 1);
  assert.equal(stats.normalCdf(-Infinity), 0);
});

test('pearsonPValue flags weak/small-n correlations as not significant', () => {
  // r=0.5 at n=10 is the classic false positive — must NOT be significant.
  assert.ok(stats.pearsonPValue(0.5, 10) > 0.05);
  // Same r at larger n IS significant.
  assert.ok(stats.pearsonPValue(0.5, 40) < 0.05);
  // Strong r on decent n is highly significant.
  assert.ok(stats.pearsonPValue(0.8, 30) < 0.001);
  // Undefined cases return null.
  assert.equal(stats.pearsonPValue(0.5, 2), null);
  assert.equal(stats.pearsonPValue(null, 30), null);
});

test('benjaminiHochberg controls the false discovery rate', () => {
  const keep = stats.benjaminiHochberg([0.001, 0.008, 0.02, 0.2, 0.5, 0.9], 0.1);
  assert.deepEqual(keep, [true, true, true, false, false, false]);
  // All-null input is safe (no significant results, no throw).
  assert.deepEqual(stats.benjaminiHochberg([null, null], 0.1), [false, false]);
});

test('baselineAnomaly flags deviations from personal norm', () => {
  const series = [];
  for (let i = 0; i < 30; i++) series.push({ day: `2026-05-${String(i + 1).padStart(2, '0')}`, value: 50 + (i % 3 - 1) * 2 });
  series.push({ day: '2026-06-01', value: 70 });
  const a = stats.baselineAnomaly(series, { baselineDays: 30, minN: 8 });
  assert.ok(a.z > 3, `spike should be a large z, got ${a.z}`);
  // A normal day is quiet.
  const normal = series.slice(0, -1).concat([{ day: '2026-06-01', value: 51 }]);
  assert.ok(Math.abs(stats.baselineAnomaly(normal, { baselineDays: 30, minN: 8 }).z) < 1);
  // Too little history → null.
  assert.equal(stats.baselineAnomaly(series.slice(0, 5)), null);
});

test('studentTTwoSided matches table values', () => {
  // Two-sided p for |t| at given df (R: 2*pt(-|t|, df)).
  assert.ok(Math.abs(stats.studentTTwoSided(2.0, 8) - 0.0805) < 1e-3);
  assert.ok(Math.abs(stats.studentTTwoSided(1.96, 1000) - 0.0502) < 2e-3);
  assert.equal(stats.studentTTwoSided(0, 8), 1);
  assert.equal(stats.studentTTwoSided(2, 0), null);
});

test('tCritical recovers the 0.975 quantile', () => {
  assert.ok(Math.abs(stats.tCritical(8) - 2.306) < 1e-2);   // t_{0.975,8}
  assert.ok(Math.abs(stats.tCritical(20) - 2.086) < 1e-2);  // t_{0.975,20}
  assert.ok(Math.abs(stats.tCritical(1e6) - 1.96) < 1e-2);  // → normal
});

test('welchTTest: clean separation is significant, noisy overlap is not', () => {
  const lo = [36, 38, 37, 39, 35];
  const hi = [50, 52, 48, 51, 49];
  const sep = stats.welchTTest(lo, hi);
  assert.ok(sep.diff > 0 && sep.p < 0.001, 'separated groups → tiny p');
  assert.ok(sep.cohenD > 2, 'large effect size');
  // Two noisy, overlapping samples with a small mean gap — must NOT be significant.
  const a = [45, 58, 38, 62, 41, 55, 40];
  const b = [48, 60, 41, 64, 44, 57, 43];
  const noise = stats.welchTTest(a, b);
  assert.ok(noise.p > 0.2, `overlapping noise should be non-significant, got p=${noise.p}`);
});

test('welchTTest: handles flat groups without NaN', () => {
  const flatDiff = stats.welchTTest([50, 50, 50], [60, 60, 60]);
  assert.equal(flatDiff.p, 0);                  // perfectly separated, zero variance
  const flatSame = stats.welchTTest([50, 50, 50], [50, 50, 50]);
  assert.equal(flatSame.p, 1);                  // identical → no effect
  assert.equal(stats.welchTTest([1], [2, 3]), null); // too few per group
});

test('fitByDay gives a true per-day slope on irregularly-sampled data', () => {
  // Rising exactly 2/day, logged with gaps (days 0, 2, 7, 14).
  const series = [
    { day: '2026-05-01', value: 100 },
    { day: '2026-05-03', value: 104 },
    { day: '2026-05-08', value: 114 },
    { day: '2026-05-15', value: 128 },
  ];
  const f = stats.fitByDay(series);
  assert.ok(Math.abs(f.slope - 2) < 1e-6, `per-day slope should be 2, got ${f.slope}`);
  assert.equal(f.spanDays, 14);
  // Index-fit would be wrong (per-sample, ignores the gaps).
  assert.ok(Math.abs(stats.linearFit(series.map((p) => p.value)).slope - 2) > 1, 'index-fit should differ');
});

test('predictionSE grows with horizon distance from the data', () => {
  const series = [
    { day: '2026-05-01', value: 100 },
    { day: '2026-05-05', value: 108 },
    { day: '2026-05-09', value: 121 },
    { day: '2026-05-13', value: 130 },
    { day: '2026-05-17', value: 145 },
  ];
  const f = stats.fitByDay(series);
  const near = stats.predictionSE(f, f.lastX + 5);
  const far = stats.predictionSE(f, f.lastX + 90);
  assert.ok(far > near, 'uncertainty should widen further out');
});
