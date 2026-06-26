const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../src/intelligence/analyze');

// Build a [{day,value}] series of `n` days from a generator.
function mkSeries(n, fn, startISO = '2026-04-01T12:00:00') {
  const out = [];
  const start = new Date(startISO);
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    out.push({ day: d.toISOString().slice(0, 10), value: fn(i) });
  }
  return out;
}

test('computeSleepImpact: surfaces best-vs-worst-night outcome splits', () => {
  const N = 42;
  // Sleep score cycles 60..90; HRV tracks it (higher on better-slept indices).
  const sleepScore = mkSeries(N, (i) => 60 + (i % 7) * 5);
  const hrv = mkSeries(N, (i) => 45 + (i % 7) * 3);
  const findings = a.computeSleepImpact({
    'health:sleep_score': sleepScore,
    'health:hrv': hrv,
  });
  const hrvF = findings.find((f) => f.evidence.outcome === 'health:hrv');
  assert.ok(hrvF, 'expected an HRV sleep-impact finding');
  assert.equal(hrvF.type, 'sleep_impact');
  assert.ok(hrvF.evidence.goodMean > hrvF.evidence.poorMean, 'good nights should show higher HRV');
  assert.ok(hrvF.evidence.goodN >= 5 && hrvF.evidence.poorN >= 5);
});

test('computeSleepImpact: returns nothing without enough nights', () => {
  const short = mkSeries(6, () => 70);
  assert.deepEqual(a.computeSleepImpact({ 'health:sleep_score': short, 'health:hrv': short }), []);
});

test('computeSleepImpact: falls back to sleep_hours when sleep_score is flat', () => {
  const N = 42;
  const flatScore = mkSeries(N, () => 80);          // no spread — old code bailed here
  const hours = mkSeries(N, (i) => 6 + (i % 7) * 0.5); // sleep_hours varies plenty
  const hrv = mkSeries(N, (i) => 45 + (i % 7) * 3);    // HRV tracks hours
  const findings = a.computeSleepImpact({
    'health:sleep_score': flatScore,
    'health:sleep_hours': hours,
    'health:hrv': hrv,
  });
  const hrvF = findings.find((f) => f.evidence.outcome === 'health:hrv');
  assert.ok(hrvF, 'expected a sleep-impact finding driven by sleep_hours');
  assert.equal(hrvF.evidence.driver, 'health:sleep_hours');
});

test('computeTrends: binary habits are skipped (no "+133% cold shower" noise)', () => {
  // 14 days: cold shower 3/7 early, 7/7 late — a huge raw "trend" that is meaningless.
  const coldShower = mkSeries(14, (i) => (i < 7 ? (i % 2) : 1));
  const exercise = mkSeries(14, (i) => (i < 7 ? (i % 3 === 0 ? 1 : 0) : 1));
  const findings = a.computeTrends({
    'habits:cold_shower': coldShower,
    'habits:exercise': exercise,
  });
  assert.equal(findings.length, 0, 'binary-habit trends should be suppressed');
});

test('computeAnomalies: labels a prior-day standout "yesterday", not "today"', () => {
  // 20 days of mood ~4.0 ending on a clearly-past date, with a 5.0 final spike.
  const mood = mkSeries(20, (i) => (i === 19 ? 5 : 4 + ((i % 3) - 1) * 0.3), '2026-05-01T12:00:00');
  const findings = a.computeAnomalies({ 'wellbeing:mood': mood });
  const moodF = findings.find((f) => f.evidence.metric === 'wellbeing:mood');
  assert.ok(moodF, 'expected a mood anomaly');
  assert.match(moodF.detail, /yesterday/);
  assert.doesNotMatch(moodF.detail, /\btoday\b/);
});

test('computeActivityImpact: flags an exercise type that costs next-day recovery', () => {
  const N = 40;
  const cycle = ['zone2', 'pull', 'intervals', 'push', 'zone2'];
  const activityTypeByDay = {};
  const start = new Date('2026-04-01T12:00:00');
  for (let i = 0; i < N; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    activityTypeByDay[d.toISOString().slice(0, 10)] = cycle[i % cycle.length];
  }
  // Next-day HRV is suppressed the day after intervals, normal otherwise.
  const hrv = mkSeries(N, (i) => (cycle[(i - 1 + cycle.length) % cycle.length] === 'intervals' ? 42 : 54));
  const findings = a.computeActivityImpact({ 'health:hrv': hrv }, activityTypeByDay);
  const f = findings.find((x) => x.evidence.outcome === 'health:hrv');
  assert.ok(f, 'expected an HRV activity-impact finding');
  assert.equal(f.evidence.activity, 'intervals');
  assert.ok(f.evidence.pct < 0, 'intervals should depress next-day HRV vs typical');
});

test('computeActivityImpact: returns nothing with too little data', () => {
  assert.deepEqual(a.computeActivityImpact({ 'health:hrv': mkSeries(3, () => 50) }, { '2026-04-01': 'pull' }), []);
});

test('computeDaytimeCardio: surfaces eating→daytime-HRV split', () => {
  const N = 30;
  // Eat-healthy alternates high (4) / low (1); daytime HRV is higher on eat-well days.
  const eat = mkSeries(N, (i) => (i % 2 === 0 ? 4 : 1));
  const hrvDay = mkSeries(N, (i) => (i % 2 === 0 ? 50 : 38));
  const findings = a.computeDaytimeCardio({
    'health:hrv_daytime': hrvDay,
    'habits:eat_healthy': eat,
  });
  const f = findings.find((x) => x.evidence.outcome === 'health:hrv_daytime');
  assert.ok(f, 'expected a daytime-HRV finding');
  assert.equal(f.type, 'daytime_cardio');
  assert.equal(f.evidence.lever, 'habits:eat_healthy');
  assert.ok(f.evidence.hiMean > f.evidence.loMean, 'eat-well days should show higher daytime HRV');
  assert.ok(f.evidence.hiN >= 5 && f.evidence.loN >= 5);
});

test('computeDaytimeCardio: RHR lever uses mood and respects good=down direction', () => {
  const N = 30;
  // High-mood days (>=4) pair with LOWER daytime RHR (better autonomic tone).
  const mood = mkSeries(N, (i) => (i % 2 === 0 ? 5 : 2));
  const rhrDay = mkSeries(N, (i) => (i % 2 === 0 ? 56 : 64));
  const findings = a.computeDaytimeCardio({
    'health:rhr_daytime': rhrDay,
    'wellbeing:mood': mood,
  });
  const f = findings.find((x) => x.evidence.outcome === 'health:rhr_daytime');
  assert.ok(f, 'expected a daytime-RHR finding');
  assert.equal(f.evidence.lever, 'wellbeing:mood');
  assert.ok(f.evidence.hiMean < f.evidence.loMean, 'high-mood days should show lower RHR');
  // good=down + lower-on-high → the narrative should frame it as an improvement.
  assert.match(f.detail, /better autonomic tone/);
});

test('computeDaytimeCardio: isolated — ignores nighttime keys entirely', () => {
  // Only nighttime keys present (no _daytime series). Must produce nothing, so it
  // can never accidentally analyze the Eight-Sleep-locked recovery series.
  const N = 30;
  const findings = a.computeDaytimeCardio({
    'health:hrv': mkSeries(N, (i) => 45 + (i % 2) * 10),
    'health:resting_hr': mkSeries(N, (i) => 60 - (i % 2) * 5),
    'habits:eat_healthy': mkSeries(N, (i) => (i % 2 === 0 ? 4 : 1)),
  });
  assert.deepEqual(findings, [], 'no _daytime series → no findings; nighttime keys must be ignored');
});

test('computeDaytimeCardio: returns nothing without enough days per bucket', () => {
  const short = mkSeries(6, (i) => (i % 2 === 0 ? 50 : 40));
  const eat = mkSeries(6, (i) => (i % 2 === 0 ? 4 : 1));
  assert.deepEqual(
    a.computeDaytimeCardio({ 'health:hrv_daytime': short, 'habits:eat_healthy': eat }),
    []
  );
});

test('computeDaytimeCardio: a noisy ~6% gap is NOT surfaced (significance gate)', () => {
  // Eat-well vs other days differ by only a few percent on average, but the
  // within-group day-to-day spread is large — exactly the kind of sampling noise
  // the OLD raw-mean engine would have mislabeled "Eating well: HRV +6%".
  const N = 30;
  // High variance on BOTH buckets, tiny true mean shift.
  const hiNoise = [50, 38, 62, 41, 58, 36, 60, 44, 55, 40, 64, 39, 57, 42, 59];
  const loNoise = [44, 60, 38, 56, 41, 59, 37, 62, 40, 54, 43, 58, 39, 61, 45];
  let hI = 0, lI = 0;
  const hrvDay = mkSeries(N, (i) => (i % 2 === 0 ? hiNoise[hI++] : loNoise[lI++]));
  const eat = mkSeries(N, (i) => (i % 2 === 0 ? 4 : 1));
  const findings = a.computeDaytimeCardio({ 'health:hrv_daytime': hrvDay, 'habits:eat_healthy': eat });
  assert.deepEqual(findings, [], 'noisy, overlapping buckets must not produce a finding');
});

test('computeDaytimeCardio: surfaced findings carry a p-value, effect size, and CI', () => {
  const N = 30;
  const eat = mkSeries(N, (i) => (i % 2 === 0 ? 4 : 1));
  const hrvDay = mkSeries(N, (i) => (i % 2 === 0 ? 50 : 38));
  const f = a.computeDaytimeCardio({ 'health:hrv_daytime': hrvDay, 'habits:eat_healthy': eat })
    .find((x) => x.evidence.outcome === 'health:hrv_daytime');
  assert.ok(f, 'expected a finding on cleanly-separated data');
  assert.ok(f.evidence.p != null && f.evidence.p < 0.05, 'evidence should carry a significant p');
  assert.ok(Number.isFinite(f.evidence.cohenD), 'evidence should carry Cohen d');
  assert.ok(Array.isArray(f.evidence.ci) && f.evidence.ci.length === 2, 'evidence should carry a CI');
});
