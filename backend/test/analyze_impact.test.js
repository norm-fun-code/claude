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
