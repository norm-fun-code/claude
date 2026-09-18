// A standing weekly calendar block, explained once, must stay explained.
//
// Reported: "every Friday it notes I have a lot of meetings — but most of it is
// my weekly 5pm-12am Sabbath block on my work calendar." Two independent bugs
// meant that correction could never stick, no matter how many times it was
// given:
//
//   1. extractClockTimeRange required a SINGLE meridiem after the second
//      number, so "5pm-12am", "5pm to midnight" and even "9am-5pm" all
//      returned null — the classification never bound to the block, so the
//      hours were never netted out of meeting load.
//   2. A midnight END was rejected by the `endMin <= startMin` guard, because
//      12am parses to 0. "5pm to 12am" looked like a backwards range.
//   3. Even bound, a classification was pinned to the exact date it was
//      stated on, so next Friday it no longer applied and the question came
//      back.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractClockTimeRange, extractWeeklyRecurrence, matchCalendarClassifications } = require('../src/intelligence/context-resolver');

// --- parsing the block as it is actually described -------------------------

test('the natural ways of writing an evening block all parse', () => {
  const evening = { startMin: 17 * 60, endMin: 24 * 60 };
  for (const s of ['5pm-12am', '5pm to 12am', '5pm to midnight', '5pm–midnight', '17:00-24:00']) {
    assert.deepEqual(extractClockTimeRange(s), evening, `failed to parse: ${s}`);
  }
});

test('an ordinary workday range parses too — it never did before', () => {
  assert.deepEqual(extractClockTimeRange('9am-5pm'), { startMin: 9 * 60, endMin: 17 * 60 });
  assert.deepEqual(extractClockTimeRange('noon to 5pm'), { startMin: 12 * 60, endMin: 17 * 60 });
});

test('a midnight END means end of day, but a midnight START still means 00:00', () => {
  assert.deepEqual(extractClockTimeRange('5pm to 12am'), { startMin: 1020, endMin: 1440 });
  assert.deepEqual(extractClockTimeRange('12am to 6am'), { startMin: 0, endMin: 360 });
});

test('the existing trailing-meridiem and backwards-range rules are unchanged', () => {
  assert.deepEqual(extractClockTimeRange("that's a Sabbath block, 5-9pm, not meetings"), { startMin: 1020, endMin: 1260 });
  assert.deepEqual(extractClockTimeRange('5 to 9pm'), { startMin: 1020, endMin: 1260 });
  assert.equal(extractClockTimeRange('9-5pm'), null, 'a genuinely backwards range is still refused');
  assert.equal(extractClockTimeRange('that meeting with the team'), null);
});

// --- recognising that it recurs -------------------------------------------

test('a weekly arrangement is recognised, and a one-off is not', () => {
  assert.equal(extractWeeklyRecurrence('every Friday 5pm to midnight is a Sabbath block'), 5);
  assert.equal(extractWeeklyRecurrence('Fridays 5pm-12am, not meetings'), 5);
  assert.equal(extractWeeklyRecurrence('my standing Friday evening block'), 5);
  assert.equal(extractWeeklyRecurrence('every Saturday morning'), 6);
  assert.equal(extractWeeklyRecurrence("that block this afternoon isn't meetings"), null);
  assert.equal(extractWeeklyRecurrence(''), null);
});

// --- and applying it on a LATER week --------------------------------------

function resolvedWith(rawText, windowStart) {
  const assertion = { id: 'a1', subject: 'Friday evening block', objectValue: 'a Sabbath block', rawText };
  return {
    tz: 'America/New_York',
    assertionById: new Map([['a1', assertion]]),
    relations: [{
      relationship: 'classifies', targetType: 'calendar_event', sourceAssertionId: 'a1',
      permittedLanguage: 'a Sabbath block, not meetings', windowStart,
    }],
  };
}
// A real work-busy block, 5pm-midnight.
const workBusy = [{ start: '5:00 PM', end: '11:59 PM' }];

test('a recurring classification still applies on a LATER week, same weekday', () => {
  // Stated Friday 11 Sep; evaluated Friday 18 Sep. This is the exact failure:
  // the correction was given, and the next Friday it was ignored.
  const resolved = resolvedWith('every Friday 5pm to midnight is a Sabbath block, not meetings', '2026-09-11T22:00:00Z');
  const out = matchCalendarClassifications(resolved, { workBusy, calendar: [], targetLocalDate: '2026-09-18' });
  assert.equal(out.length, 1, 'the standing weekly block must still be reclassified');
  assert.match(out[0].title, /Sabbath/);
});

test('a recurring classification does NOT leak onto a different weekday', () => {
  const resolved = resolvedWith('every Friday 5pm to midnight is a Sabbath block, not meetings', '2026-09-11T22:00:00Z');
  // 2026-09-17 is a Thursday.
  assert.deepEqual(matchCalendarClassifications(resolved, { workBusy, calendar: [], targetLocalDate: '2026-09-17' }), []);
});

test('a ONE-OFF classification still expires with its date', () => {
  // The original guard exists for a reason: "that block this afternoon isn't
  // meetings" must not silently reclassify the same clock window next week.
  const resolved = resolvedWith("that 5pm to 12am block today isn't meetings", '2026-09-11T22:00:00Z');
  assert.deepEqual(matchCalendarClassifications(resolved, { workBusy, calendar: [], targetLocalDate: '2026-09-18' }), []);
  // ...but it does apply on its own date.
  assert.equal(matchCalendarClassifications(resolved, { workBusy, calendar: [], targetLocalDate: '2026-09-11' }).length, 1);
});
