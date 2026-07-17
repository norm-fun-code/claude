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

// classifiedOverrides (harden pass, item 3a) — a calendar-classification
// correction matched by context-resolver.js's matchCalendarClassifications
// must suppress this very question, not just change the number shown inside
// prose elsewhere. Unlike the mirrored-Sabbath tests above, there is no
// NAMED personal-calendar event here at all — the override is the ONLY
// reason this work-busy block nets out.
test('classifiedOverrides nets a reclassified work-busy block out of the packed-calendar signal even with no named personal-calendar event', () => {
  const workBusy = [{ start: '5:00 PM', end: '9:00 PM' }];
  const withoutOverride = buildSignals({ recovery: null, workBusy, calendar: [], now: NOW, tz: TZ });
  assert.ok(withoutOverride.find((s) => s.key === TODAY_KEY), 'sanity: 4h of unclassified busy time should fire the signal');

  const classifiedOverrides = [{ title: 'a Sabbath observance, not meetings', startTime: '5:00 PM', endTime: '9:00 PM', allDay: false }];
  const withOverride = buildSignals({ recovery: null, workBusy, calendar: [], now: NOW, tz: TZ, classifiedOverrides });
  assert.equal(withOverride.find((s) => s.key === TODAY_KEY), undefined,
    'the reclassified block must net to 0h of real meeting load, well under the 4h threshold');
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

// Audit fix: the tomorrow look-ahead used to call computeCalendarLoad with
// calendar: [] (personal events never fetched), so a mirrored Sabbath block
// had nothing to net against and inflated tomorrow's load exactly like the
// already-fixed same-day bug. tomorrowCalendar must reach the same canonical
// projection tomorrowWorkBusy does.
test('tomorrow look-ahead: a mirrored Sabbath block reports the NET hours, not the gross block', () => {
  const dayBefore = new Date('2026-07-16T15:00:00Z');
  // 12h gross work-busy block, 4h of which mirrors the Sabbath -> 8h net,
  // still over the 6h look-ahead threshold so it fires with the right number.
  const tomorrowWorkBusy = [{ start: '9:00 AM', end: '9:00 PM' }];
  const tomorrowCalendar = [{ title: 'Sabbath', startTime: '5:00 PM', endTime: '9:00 PM', allDay: false }];
  const signals = buildSignals({
    recovery: null, workBusy: [], calendar: [], tomorrowWorkBusy, tomorrowCalendar, now: dayBefore, tz: TZ,
  });
  const lookAhead = signals.find((s) => s.key === TODAY_KEY);
  assert.ok(lookAhead, 'the net 8h load should still clear the 6h look-ahead threshold');
  assert.match(lookAhead.question, /8\.0h/, 'must report the NET 8h (12h gross minus the 4h Sabbath overlap), not 12h');
});

test('tomorrow look-ahead: a mirrored Sabbath block that nets BELOW threshold produces no false-positive signal', () => {
  const dayBefore = new Date('2026-07-16T15:00:00Z');
  // Exactly the bug report's reproduction: 1-9pm work-busy, 5-9pm mirrored
  // Sabbath -> nets to 4h, well under the 6h look-ahead threshold. The OLD
  // code (calendar: [] always) would have reported the gross 8h and
  // incorrectly fired "heavily blocked."
  const tomorrowWorkBusy = [{ start: '1:00 PM', end: '9:00 PM' }];
  const tomorrowCalendar = [{ title: 'Sabbath', startTime: '5:00 PM', endTime: '9:00 PM', allDay: false }];
  const signals = buildSignals({
    recovery: null, workBusy: [], calendar: [], tomorrowWorkBusy, tomorrowCalendar, now: dayBefore, tz: TZ,
  });
  assert.equal(signals.find((s) => s.key === TODAY_KEY), undefined,
    'the net 4h load must never trigger the look-ahead question — the gross 8h would have');
});

// Full production-path sequence: yesterday's look-ahead (with the Sabbath
// netting applied) is answered; today's build, computing the identical net
// load from the SAME underlying schedule, must come back suppressed.
test('full sequence: answering yesterday\'s Sabbath-netted look-ahead suppresses today\'s otherwise-identical question', () => {
  const dayBefore = new Date('2026-07-16T15:00:00Z');
  const workBusyBlock = [{ start: '9:00 AM', end: '9:00 PM' }]; // 12h gross
  const calendarBlock = [{ title: 'Sabbath', startTime: '5:00 PM', endTime: '9:00 PM', allDay: false }]; // 4h overlap

  const dayBeforeSignals = buildSignals({
    recovery: null, workBusy: [], calendar: [], tomorrowWorkBusy: workBusyBlock, tomorrowCalendar: calendarBlock,
    now: dayBefore, tz: TZ,
  });
  const lookAhead = dayBeforeSignals.find((s) => s.key === TODAY_KEY);
  assert.ok(lookAhead, 'sanity: the 8h net load should fire the look-ahead question');
  assert.equal(lookAhead.fingerprint, '8.00');

  // The answer is recorded server-side against calendar_load:2026-07-17 with
  // the fingerprint the look-ahead computed (see routes/annotations.js).
  const answered = new Map([['2026-07-17', { fingerprint: lookAhead.fingerprint, answer: 'work offsite' }]]);

  // Today's build: the SAME underlying schedule (now today's, not tomorrow's)
  // — same 12h gross work-busy block, same mirrored Sabbath — nets to the
  // identical 8h. Without the tomorrowCalendar fix this fingerprint would
  // never have matched (yesterday's fingerprint would have been the WRONG
  // gross 12h), so the suppression would have silently failed too.
  const todaySignals = buildSignals({
    recovery: null, workBusy: workBusyBlock, calendar: calendarBlock, now: NOW, tz: TZ, calendarLoadAnswers: answered,
  });
  assert.equal(todaySignals.find((s) => s.key === TODAY_KEY), undefined,
    'today\'s identical-load question must be suppressed by yesterday\'s answer');
});

// Audit3 fix 4: a failed personal-calendar fetch used to be indistinguishable
// from "no personal events" (both -> calendar: []), which can recreate the
// mirrored-Sabbath double-counting bug — a mirrored block has nothing to net
// against, so a degraded personal-calendar fetch could inflate today's
// meeting-load claim even though the WORK free/busy fetch succeeded fine.
test('personal-calendar fetch rejected but work free/busy succeeds: no packed-calendar question, even with heavy work-busy hours', () => {
  const workBusy = [{ start: '9:00 AM', end: '4:00 PM' }]; // 7h, well over threshold
  const signals = buildSignals({
    recovery: null, workBusy, calendar: [], now: NOW, tz: TZ,
    workBusyAvailable: true, calendarAvailable: false,
  });
  assert.equal(signals.find((s) => s.key === TODAY_KEY), undefined,
    'a degraded/unavailable personal-calendar source must suppress the question rather than assert a possibly-false meeting-load claim');
});

test('both sources available with the same heavy load DOES still fire (sanity: the suppression is specific to unavailability, not to heavy load)', () => {
  const workBusy = [{ start: '9:00 AM', end: '4:00 PM' }];
  const signals = buildSignals({
    recovery: null, workBusy, calendar: [], now: NOW, tz: TZ,
    workBusyAvailable: true, calendarAvailable: true,
  });
  assert.ok(signals.find((s) => s.key === TODAY_KEY), 'with both sources available, the genuine 7h load must still trip the question');
});

test('tomorrow look-ahead: personal-calendar fetch rejected but work free/busy succeeds suppresses the look-ahead question too', () => {
  const dayBefore = new Date('2026-07-16T15:00:00Z');
  const tomorrowWorkBusy = [{ start: '9:00 AM', end: '5:00 PM' }]; // 8h, over the 6h look-ahead threshold
  const signals = buildSignals({
    recovery: null, workBusy: [], calendar: [], tomorrowWorkBusy, tomorrowCalendar: [], now: dayBefore, tz: TZ,
    tomorrowWorkBusyAvailable: true, tomorrowCalendarAvailable: false,
  });
  assert.equal(signals.find((s) => s.key === TODAY_KEY), undefined,
    'an unavailable personal calendar for tomorrow must suppress the look-ahead question, same failure mode as today\'s');
});
