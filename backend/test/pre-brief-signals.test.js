const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSignals } = require('../src/intelligence/pre-brief-signals');

const NOW = new Date('2026-07-17T15:00:00Z'); // 11am ET
const TZ = 'America/New_York';
const TODAY_KEY = 'calendar_load:2026-07-17';

// Regression test: workBusy/calendar times arrive as bare 12-hour strings
// ("2:00 PM"), which `new Date(...)` can't parse — the old implementation
// silently computed 0 meeting-minutes forever, so this signal never fired.

test('packed_calendar fires when work-busy blocks total >= 4h', () => {
  const workBusy = [
    { start: '9:00 AM', end: '12:00 PM' },
    { start: '1:00 PM', end: '3:00 PM' },
  ];
  const signals = buildSignals({ recovery: null, workBusy, calendar: [], now: NOW, tz: TZ });
  const packed = signals.find((s) => s.key === TODAY_KEY);
  assert.ok(packed, 'calendar_load signal should fire for 5 hours of meetings');
  assert.match(packed.question, /5\.0h/);
});

test('packed_calendar does not fire under the 4h threshold', () => {
  const workBusy = [{ start: '9:00 AM', end: '11:00 AM' }];
  const signals = buildSignals({ recovery: null, workBusy, calendar: [], now: NOW, tz: TZ });
  assert.equal(signals.find((s) => s.key === TODAY_KEY), undefined);
});

test('packed_calendar correctly sums time crossing the noon boundary (AM/PM parsing)', () => {
  // 11:00 AM - 4:00 PM must be read as 5 hours, not treated as if PM < AM.
  const workBusy = [{ start: '11:00 AM', end: '4:00 PM' }];
  const signals = buildSignals({ recovery: null, workBusy, calendar: [], now: NOW, tz: TZ });
  const packed = signals.find((s) => s.key === TODAY_KEY);
  assert.ok(packed);
  assert.match(packed.question, /5\.0h/);
});

// Bug fix: personal-calendar events must NEVER count toward meeting load —
// blocking personal time off is protecting it, not a source of load. Only
// WORK-BUSY intervals ever contribute minutes (see intelligence/calendar-load.js).
test('personal calendar events alone never count toward meeting time', () => {
  const calendar = [
    { allDay: false, startTime: '2:00 PM', endTime: '6:30 PM', title: 'Offsite' },
  ];
  const signals = buildSignals({ recovery: null, workBusy: [], calendar, now: NOW, tz: TZ });
  assert.equal(signals.find((s) => s.key === TODAY_KEY), undefined,
    'a personal-calendar-only day must never trip the packed-calendar question');
});

// The bug report's exact reproduction: a Sabbath block mirrored onto BOTH the
// personal calendar (named) and the work calendar's free/busy feed (titleless)
// must be counted ONCE — as protected personal time, not as 4h of meetings on
// top of it — so a day with a 5-9pm Sabbath block and no other meetings never
// reproduces "8.0h of meetings."
test('a mirrored Sabbath block produces no packed-calendar signal', () => {
  const calendar = [{ allDay: false, startTime: '5:00 PM', endTime: '9:00 PM', title: 'Sabbath' }];
  const workBusy = [{ start: '5:00 PM', end: '9:00 PM' }]; // mirrored, titleless
  const signals = buildSignals({ recovery: null, workBusy, calendar, now: NOW, tz: TZ });
  assert.equal(signals.find((s) => s.key === TODAY_KEY), undefined,
    'the Sabbath block must net to 0h of real meeting load, well under the 4h threshold');
});

test('a mirrored Sabbath block does not mask a GENUINE additional 5h of meetings', () => {
  const calendar = [{ allDay: false, startTime: '5:00 PM', endTime: '9:00 PM', title: 'Sabbath' }];
  const workBusy = [
    { start: '5:00 PM', end: '9:00 PM' }, // mirrored Sabbath — nets to 0
    { start: '9:00 AM', end: '2:00 PM' }, // 5h of real, unrelated meetings
  ];
  const signals = buildSignals({ recovery: null, workBusy, calendar, now: NOW, tz: TZ });
  const packed = signals.find((s) => s.key === TODAY_KEY);
  assert.ok(packed, 'the genuine 5h of meetings must still trip the threshold');
  assert.match(packed.question, /5\.0h/, 'the Sabbath overlap must not be added on top of the real meetings');
});

test('all-day calendar events are excluded from meeting time', () => {
  const calendar = [{ allDay: true, startTime: null, endTime: null, title: 'Vacation' }];
  const signals = buildSignals({ recovery: null, workBusy: [], calendar, now: NOW, tz: TZ });
  assert.equal(signals.find((s) => s.key === TODAY_KEY), undefined);
});

// Bug fix: an all-day WORK-calendar block (OOO/PTO/holiday/travel, mirrored
// onto the titleless free/busy feed) must read as protected time, not as a
// day "packed with meetings."
test('an all-day work-calendar block is treated as OOO, not meeting load', () => {
  const workBusy = [{ start: '8:00 AM', end: '6:00 PM' }];
  const signals = buildSignals({ recovery: null, workBusy, calendar: [], now: NOW, tz: TZ });
  assert.equal(signals.find((s) => s.key === TODAY_KEY), undefined);
});

// Bug fix: overlapping/double-booked work-busy blocks must be merged into
// their union before summing, not double-counted.
test('overlapping work-busy blocks are unioned, not double-counted', () => {
  const workBusy = [
    { start: '9:00 AM', end: '1:00 PM' },
    { start: '11:00 AM', end: '3:00 PM' }, // overlaps the first by 2h
  ];
  const signals = buildSignals({ recovery: null, workBusy, calendar: [], now: NOW, tz: TZ });
  const packed = signals.find((s) => s.key === TODAY_KEY);
  assert.ok(packed);
  assert.match(packed.question, /6\.0h/, 'the union of 9am-1pm and 11am-3pm is 6h, not 8h');
});

test('recovery_low and spending_spike are unaffected by the calendar fix', () => {
  const signals = buildSignals({ recovery: { score: 42 }, spend: 200, spendBaseline: 50, now: NOW, tz: TZ });
  assert.ok(signals.find((s) => s.key === 'recovery_low'));
  assert.ok(signals.find((s) => s.key === 'spending_spike'));
});

// Bug fix: yesterday's "tomorrow is heavily blocked" question and today's
// "packed calendar" question about the SAME underlying date must share the
// same durable subject key, and an answer recorded against that key must
// suppress the question on a LATER build (not just within one call).
test('the tomorrow-look-ahead signal and same-day packed-calendar signal share one durable key', () => {
  const dayBefore = new Date('2026-07-16T15:00:00Z');
  const heavyBlock = [{ start: '9:00 AM', end: '4:00 PM' }]; // 7h
  const tomorrowSignals = buildSignals({
    recovery: null, workBusy: [], calendar: [], tomorrowWorkBusy: heavyBlock, now: dayBefore, tz: TZ,
  });
  const lookAhead = tomorrowSignals.find((s) => s.key === TODAY_KEY);
  assert.ok(lookAhead, 'the day-before look-ahead question must use calendar_load:<the date it describes>');

  const answered = new Map([['2026-07-17', { fingerprint: lookAhead.fingerprint, answer: 'travel day' }]]);
  const sameDaySignals = buildSignals({
    recovery: null, workBusy: heavyBlock, calendar: [], now: NOW, tz: TZ, calendarLoadAnswers: answered,
  });
  assert.equal(sameDaySignals.find((s) => s.key === TODAY_KEY), undefined,
    'answering yesterday\'s look-ahead question must suppress today\'s otherwise-identical packed-calendar question');
});

test('a materially changed schedule is asked about again despite a stored answer', () => {
  const workBusy = [{ start: '9:00 AM', end: '2:00 PM' }]; // 5h
  const stale = new Map([['2026-07-17', { fingerprint: '1.00', answer: 'old note' }]]); // schedule was 1h when answered
  const signals = buildSignals({ recovery: null, workBusy, calendar: [], now: NOW, tz: TZ, calendarLoadAnswers: stale });
  assert.ok(signals.find((s) => s.key === TODAY_KEY),
    'a schedule that moved from 1h to 5h since the stored answer must re-ask, not stay suppressed');
});
