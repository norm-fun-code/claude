const test = require('node:test');
const assert = require('node:assert/strict');
const { forecastGoal } = require('../src/intelligence/forecast');

const ASOF = new Date('2026-05-30T00:00:00Z');

// Build an ascending daily series rising linearly from `start` by `step`/day.
function ramp(start, step, days) {
  return Array.from({ length: days }, (_, i) => ({ value: start + step * i }));
}

function targetDate(daysFromAsOf) {
  const d = new Date(ASOF);
  d.setUTCDate(d.getUTCDate() + daysFromAsOf);
  return d.toISOString().slice(0, 10);
}

test('upward goal comfortably on pace → high probability, on_track', () => {
  // 30 days climbing 40→69 (≈+1/day); target 80 in 20 days → projected ≈89.
  const series = ramp(40, 1, 30);
  const goal = {
    id: 'g1', domain: 'health', metric: 'hrv', title: 'Raise HRV',
    target_value: 80, baseline_value: 40, target_date: targetDate(20), unit: 'ms',
  };
  const f = forecastGoal(goal, series, { asOf: ASOF });
  assert.equal(f.type, 'forecast');
  assert.equal(f.evidence.status, 'on_track');
  assert.ok(f.confidence > 0.9, `expected high prob, got ${f.confidence}`);
  assert.ok(f.evidence.projectedValue >= 80);
  assert.ok(/by May 30, 2026|by Jun 19, 2026/.test(f.title) || f.title.includes('%'));
});

test('upward goal far out of reach → low probability, off_track', () => {
  const series = ramp(40, 1, 30); // current ≈69, +1/day
  const goal = {
    id: 'g2', domain: 'health', metric: 'hrv', title: 'Moonshot HRV',
    target_value: 200, baseline_value: 40, target_date: targetDate(10),
  };
  const f = forecastGoal(goal, series, { asOf: ASOF });
  assert.equal(f.evidence.status, 'off_track');
  assert.ok(f.confidence < 0.1, `expected low prob, got ${f.confidence}`);
});

test('downward goal (lower is better) on pace → high probability', () => {
  // body_fat falling 30→~20 over 30 days (≈-0.345/day); target 15 in 20 days.
  const series = ramp(30, -10 / 29, 30);
  const goal = {
    id: 'g3', domain: 'health', metric: 'body_fat', title: 'Cut body fat',
    target_value: 15, baseline_value: 30, target_date: targetDate(20), unit: '%',
  };
  const f = forecastGoal(goal, series, { asOf: ASOF });
  assert.ok(f.confidence > 0.8, `expected high prob, got ${f.confidence}`);
  assert.ok(f.evidence.slopePerDay < 0, 'trend should be downward');
});

test('no target_date → no probability, but a projected crossing date', () => {
  const series = ramp(40, 1, 30);
  const goal = {
    id: 'g4', domain: 'health', metric: 'hrv', title: 'Reach 80 HRV',
    target_value: 80, baseline_value: 40, target_date: null,
  };
  const f = forecastGoal(goal, series, { asOf: ASOF });
  assert.equal(f.confidence, null);
  assert.equal(f.evidence.status, 'on_pace');
  assert.ok(f.evidence.projectedDate, 'should project a crossing date');
  assert.match(f.title, /on pace/);
});

test('flat trend away from target and no date → stalled, no crossing', () => {
  const series = ramp(50, 0, 30); // flat at 50
  const goal = {
    id: 'g5', domain: 'health', metric: 'hrv', title: 'Reach 80 HRV',
    target_value: 80, target_date: null,
  };
  const f = forecastGoal(goal, series, { asOf: ASOF });
  assert.equal(f.evidence.status, 'stalled');
  assert.equal(f.evidence.projectedDate, null);
});

test('too little history → insufficient_data, null confidence', () => {
  const f = forecastGoal(
    { id: 'g6', domain: 'health', metric: 'hrv', title: 'New goal', target_value: 80 },
    [{ value: 50 }, { value: 51 }],
    { asOf: ASOF }
  );
  assert.equal(f.evidence.status, 'insufficient_data');
  assert.equal(f.confidence, null);
});

test('non-metric goal is skipped', () => {
  assert.equal(forecastGoal({ id: 'x', title: 'vague', domain: 'life' }, [], {}), null);
});
