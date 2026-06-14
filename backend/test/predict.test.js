const test = require('node:test');
const assert = require('node:assert/strict');
const { predictCapacity, sleepDebtTrajectory } = require('../src/intelligence/predict');

test('high recovery → A day, full send', () => {
  const r = predictCapacity({ recoveryScore: 80, hrvSubScore: 70 });
  assert.equal(r.grade, 'A');
  assert.equal(r.band, 'green');
  assert.match(r.prescription, /full stack|bank progress/i);
});

test('mid recovery → B day, essentials', () => {
  const r = predictCapacity({ recoveryScore: 58 });
  assert.equal(r.grade, 'B');
  assert.equal(r.band, 'yellow');
  assert.match(r.prescription, /essentials|consistency/i);
});

test('low recovery → C day, anything that compounds above zero', () => {
  const r = predictCapacity({ recoveryScore: 30, hrvSubScore: 25, sleepHours: 5.5 });
  assert.equal(r.grade, 'C');
  assert.equal(r.band, 'red');
  // The C-day philosophy: not zero — a walk, a meditation, one habit.
  assert.match(r.prescription, /zero/i);
  assert.match(r.prescription, /walk|meditation|habit/i);
  // Drivers are named.
  assert.match(r.detail, /HRV is down/i);
});

test('boundary: 67 is an A, 66 is a B, 50 is a B, 49 is a C', () => {
  assert.equal(predictCapacity({ recoveryScore: 67 }).grade, 'A');
  assert.equal(predictCapacity({ recoveryScore: 66 }).grade, 'B');
  assert.equal(predictCapacity({ recoveryScore: 50 }).grade, 'B');
  assert.equal(predictCapacity({ recoveryScore: 49 }).grade, 'C');
});

test('null/invalid recovery score → no forecast', () => {
  assert.equal(predictCapacity({ recoveryScore: null }), null);
  assert.equal(predictCapacity({}), null);
  assert.equal(predictCapacity({ recoveryScore: NaN }), null);
});

test('A day with spiking load gets a smart-intensity caution', () => {
  const r = predictCapacity({ recoveryScore: 75, acwrBand: 'high' });
  assert.match(r.prescription, /spiking|intensity/i);
});

test('sleep-debt trajectory: names hours, weekday, and the HRV lag', () => {
  const asOf = new Date('2026-06-14T12:00:00Z'); // a Sunday
  const t = sleepDebtTrajectory({ debtHours: 1.6, needHours: 7.87, asOf });
  assert.equal(t.debtHours, 1.6);
  assert.equal(t.nights, 2);
  assert.match(t.detail, /1h 36m in sleep debt/);
  assert.match(t.detail, /7h 52m need/);
  assert.match(t.detail, /HRV/);
});

test('negligible sleep debt (< 1h) returns null — no nagging', () => {
  assert.equal(sleepDebtTrajectory({ debtHours: 0.4, needHours: 8 }), null);
  assert.equal(sleepDebtTrajectory({ debtHours: null }), null);
});

test('large debt switches from "by weekday" to "about N nights"', () => {
  const t = sleepDebtTrajectory({ debtHours: 6, needHours: 8 });
  assert.equal(t.nights, 6);
  assert.match(t.detail, /about 6 solid nights/i);
});
