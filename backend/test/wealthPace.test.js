// Pure-function unit tests for services/wealth-pace.js's matched-pace
// arithmetic — no database needed. Real-Postgres coverage (coverage tiers,
// drivers, cross-surface identity) lives in
// test/integration/wealth-matched-pace.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  daysInMonth, monthOffset, matchedDayOfMonth, dayKeyUtc, paceLabelFor, pctOrNull,
  PACE_MIN_DOLLARS, MIN_MEANINGFUL_BASELINE,
} = require('../src/services/wealth-pace');

test('required: 28-day comparison — elapsed fraction of a 31-day month matches proportionally into February', () => {
  // Day 28 of a 31-day month is 28/31 = ~90.3% elapsed; matched against a
  // 28-day February that's round(0.903 * 28) = 25.
  assert.equal(matchedDayOfMonth(28, 31, 28), 25);
});

test('required: 30-day comparison — the LAST day of a 30-day month matches the LAST day of a 31-day month (whole month, not day 30)', () => {
  assert.equal(matchedDayOfMonth(30, 30, 31), 31);
});

test('required: 31-day comparison — the last day of a 31-day month matches the whole of a 28-day February, never an out-of-range day', () => {
  assert.equal(matchedDayOfMonth(31, 31, 28), 28);
});

test('required: February and leap years — daysInMonth resolves 28/29 correctly', () => {
  assert.equal(daysInMonth(2027, 2), 28, '2027 is not a leap year');
  assert.equal(daysInMonth(2028, 2), 29, '2028 is a leap year (divisible by 4)');
  assert.equal(daysInMonth(2000, 2), 29, '2000 is a leap year (divisible by 400)');
});

test('required: a mid-month elapsed fraction matches proportionally regardless of which month is longer or shorter', () => {
  // Day 15 of a 30-day month is exactly 50% elapsed; matched into a 31-day
  // month that's round(0.5 * 31) = 16 (round-half-up).
  assert.equal(matchedDayOfMonth(15, 30, 31), 16);
  // Day 14 of a 28-day February is exactly 50% elapsed; matched into a
  // 31-day month that's round(0.5 * 31) = 16 too — same fraction, same day.
  assert.equal(matchedDayOfMonth(14, 28, 31), 16);
});

test('matchedDayOfMonth is always clamped to at least 1 and at most the target month length', () => {
  assert.equal(matchedDayOfMonth(0, 30, 31), 1, 'never below day 1');
  assert.equal(matchedDayOfMonth(31, 31, 31), 31, 'never above the target month length');
});

test('required: monthOffset correctly rolls back across a year boundary', () => {
  assert.deepEqual(monthOffset(2027, 1, 1), { y: 2026, m: 12 }, 'one month before January is December of the PRIOR year');
  assert.deepEqual(monthOffset(2026, 7, 12), { y: 2025, m: 7 }, 'twelve months before July 2026 is July 2025');
  assert.deepEqual(monthOffset(2026, 3, 3), { y: 2025, m: 12 });
});

test('dayKeyUtc anchors to UTC midnight of the local Y-M-D string, matching the metrics day-key convention', () => {
  assert.equal(dayKeyUtc(2026, 7, 1).toISOString(), '2026-07-01T00:00:00.000Z');
  assert.equal(dayKeyUtc(2028, 2, 29).toISOString(), '2028-02-29T00:00:00.000Z', 'leap day anchors correctly');
});

test('required: paceLabelFor bands — below/near/above/well-above typical pace', () => {
  assert.equal(paceLabelFor(1000, 0.5), 'below_typical');
  assert.equal(paceLabelFor(100, 1.05), 'near_typical');
  assert.equal(paceLabelFor(1000, 1.2), 'above_typical');
  assert.equal(paceLabelFor(2000, 1.5), 'well_above_typical');
});

test('required: a dollar swing smaller than PACE_MIN_DOLLARS reads as near-typical regardless of ratio', () => {
  assert.ok(Math.abs(30) < PACE_MIN_DOLLARS);
  assert.equal(paceLabelFor(30, 5.0), 'near_typical', 'a huge ratio against a tiny dollar amount is still noise, not a real pace signal');
});

test('required: zero or tiny baselines hide the percentage comparison', () => {
  assert.equal(pctOrNull(50, 0), null, 'a zero baseline never produces a percentage');
  assert.ok(100 < MIN_MEANINGFUL_BASELINE);
  assert.equal(pctOrNull(50, 100), null, 'a too-small baseline is hidden, not shown as a manufactured percentage');
  assert.equal(pctOrNull(50, 200), 25, 'a meaningful baseline DOES produce a percentage');
});
