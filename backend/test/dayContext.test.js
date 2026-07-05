const test = require('node:test');
const assert = require('node:assert/strict');
const { usHolidayName, describeDayOff, isDayOff } = require('../src/util/dayContext');

test('July 4 2026 falls on Saturday → observed Friday July 3', () => {
  assert.equal(usHolidayName(2026, 7, 4), null);        // actual date, not observed
  assert.equal(usHolidayName(2026, 7, 3), 'Independence Day'); // observed
});

test("New Year's observed shift: Jan 1 2028 is a Saturday → observed Dec 31? (fixed-date only shifts within its own scan)", () => {
  // Jan 1 2028 is Saturday → observed Friday Dec 31 2027; our scanner checks Jan 1
  // of the queried year, so Jan 1 2028 itself returns null (observed is prior day).
  assert.equal(usHolidayName(2028, 1, 1), null);
  // A year where Jan 1 is midweek returns the holiday on the 1st.
  assert.equal(usHolidayName(2026, 1, 1), "New Year's Day"); // Thu
});

test('floating holidays resolve to the right weekday', () => {
  assert.equal(usHolidayName(2026, 11, 26), 'Thanksgiving');   // 4th Thu Nov 2026
  assert.equal(usHolidayName(2026, 5, 25), 'Memorial Day');    // last Mon May 2026
  assert.equal(usHolidayName(2026, 9, 7), 'Labor Day');        // 1st Mon Sep 2026
});

test('describeDayOff: Friday July 3 2026 reads as the observed July 4th holiday + long weekend', () => {
  const s = describeDayOff('2026-07-03');
  assert.match(s, /Friday/);
  assert.match(s, /Independence Day/);
  assert.match(s, /long holiday weekend/);
  assert.match(s, /DAY OFF/);
});

test('describeDayOff: a plain Saturday is the weekend', () => {
  const s = describeDayOff('2026-07-11'); // Saturday
  assert.match(s, /Saturday/);
  assert.match(s, /weekend/);
});

test('describeDayOff: a normal working weekday is empty', () => {
  assert.equal(describeDayOff('2026-07-07'), ''); // Tuesday, no holiday
});

test('describeDayOff: the day before a holiday gives a heads-up', () => {
  // Thursday July 2 2026 → next day (Fri Jul 3) is the observed holiday.
  const s = describeDayOff('2026-07-02');
  assert.match(s, /Tomorrow is Independence Day/);
});

test('describeDayOff: bad input is safe', () => {
  assert.equal(describeDayOff(''), '');
  assert.equal(describeDayOff('nonsense'), '');
});

// ── isDayOff: same underlying rule, exposed as a plain boolean for callers
// describing a day OTHER than today (e.g. the evening brief on TOMORROW) ────

test('isDayOff: a plain weekday is not a day off', () => {
  assert.deepEqual(isDayOff('2026-07-07'), { dayOff: false, holiday: null }); // Tuesday
});

test('isDayOff: a Saturday is a day off with no holiday name', () => {
  assert.deepEqual(isDayOff('2026-07-11'), { dayOff: true, holiday: null });
});

test('isDayOff: an observed holiday is a day off and names it', () => {
  assert.deepEqual(isDayOff('2026-07-03'), { dayOff: true, holiday: 'Independence Day' });
});

test('isDayOff: bad input is safe', () => {
  assert.deepEqual(isDayOff(''), { dayOff: false, holiday: null });
  assert.deepEqual(isDayOff('nonsense'), { dayOff: false, holiday: null });
});
