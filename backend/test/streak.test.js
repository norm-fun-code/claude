const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStreak, prevDay } = require('../src/util/streak');

const anchor = { today: '2026-07-02', yesterday: '2026-07-01' };
const rows = (...days) => days.map((day) => ({ day, val: 1 }));

test('prevDay handles month and year boundaries (UTC, DST-safe)', () => {
  assert.equal(prevDay('2026-07-02'), '2026-07-01');
  assert.equal(prevDay('2026-07-01'), '2026-06-30'); // month boundary
  assert.equal(prevDay('2027-01-01'), '2026-12-31'); // year boundary
  assert.equal(prevDay('2026-03-09'), '2026-03-08'); // across US DST spring-forward
});

test('a live streak ending today counts every consecutive done day', () => {
  assert.equal(computeStreak(rows('2026-07-02', '2026-07-01', '2026-06-30'), anchor), 3);
});

test('a streak ending yesterday still counts (not logged yet today)', () => {
  assert.equal(computeStreak(rows('2026-07-01', '2026-06-30'), anchor), 2);
});

test('a gap breaks the streak', () => {
  // today, yesterday, then skips 6/30 → only 2.
  assert.equal(computeStreak(rows('2026-07-02', '2026-07-01', '2026-06-29'), anchor), 2);
});

test('a not-done day (val < 0.5) breaks the streak', () => {
  const r = [
    { day: '2026-07-02', val: 1 },
    { day: '2026-07-01', val: 0 },
    { day: '2026-06-30', val: 1 },
  ];
  assert.equal(computeStreak(r, anchor), 1);
});

test('a stale streak (most recent is older than yesterday) is 0', () => {
  assert.equal(computeStreak(rows('2026-06-28', '2026-06-27'), anchor), 0);
});

test('empty / missing input is 0', () => {
  assert.equal(computeStreak([], anchor), 0);
  assert.equal(computeStreak(undefined, anchor), 0);
});

test('regression: a Date.toString()-style key would NOT match the anchor', () => {
  // The exact bug we fixed — pre-fix, day keys looked like this and never matched.
  const broken = [{ day: 'Thu Jul 02 2026', val: 1 }];
  assert.equal(computeStreak(broken, anchor), 0);
});
