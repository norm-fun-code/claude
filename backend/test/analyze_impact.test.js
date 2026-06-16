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
