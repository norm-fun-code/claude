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

// Wealth matched-pace audit: SYMMETRIC 5-band scheme — within +/-10% is
// "in_line"; 10-20% either side is "slightly_*"; beyond 20% either side is
// "comfortably_below" / "comfortably_above". Replaces the old asymmetric
// scheme (a single "below_typical" bucket cut at -10%, but a separate
// "well_above_typical" tier on the high side only past +35%) — that
// asymmetry, and the missing "slightly below" bucket specifically, is what
// let an 11%-below month render as "comfortably below pace": there was no
// finer label for the copy layer to reach for.
test('required: paceLabelFor bands — symmetric in_line/slightly/comfortably on both sides', () => {
  assert.equal(paceLabelFor(1000, 0.5), 'comfortably_below', '50% below -> comfortably below (>20% past typical)');
  assert.equal(paceLabelFor(1000, 0.89), 'slightly_below', '11% below -> slightly below (10-20% past typical)');
  assert.equal(paceLabelFor(100, 1.05), 'in_line', 'within +/-10% -> in line with typical');
  assert.equal(paceLabelFor(1000, 1.15), 'slightly_above', '15% above -> slightly above (10-20% past typical)');
  assert.equal(paceLabelFor(2000, 1.5), 'comfortably_above', '50% above -> comfortably above (>20% past typical)');
});

test('required: 11% below typical renders "slightly_below", never "comfortably_below" (the exact reported production bug)', () => {
  // medianBaseline $9,337, currentAmount $8,272 -> ratio ~0.886, ~11% below.
  const ratio = 8272 / 9337;
  assert.equal(paceLabelFor(8272 - 9337, ratio), 'slightly_below');
});

test('required: a dollar swing smaller than PACE_MIN_DOLLARS reads as in-line regardless of ratio', () => {
  assert.ok(Math.abs(30) < PACE_MIN_DOLLARS);
  assert.equal(paceLabelFor(30, 5.0), 'in_line', 'a huge ratio against a tiny dollar amount is still noise, not a real pace signal');
});

test('required: zero or tiny baselines hide the percentage comparison', () => {
  assert.equal(pctOrNull(50, 0), null, 'a zero baseline never produces a percentage');
  assert.ok(100 < MIN_MEANINGFUL_BASELINE);
  assert.equal(pctOrNull(50, 100), null, 'a too-small baseline is hidden, not shown as a manufactured percentage');
  assert.equal(pctOrNull(50, 200), 25, 'a meaningful baseline DOES produce a percentage');
});
