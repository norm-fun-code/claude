// Pure unit coverage for intelligence/open-question-subject.js — the
// deterministic (no LLM) classifier that decides whether a freshly
// generated Chief Brief openQuestion is ABOUT the canonical calendar-load
// figure, and if so, which exact work-busy block(s) it describes. See
// test/integration/open-question-calendar-provenance.test.js for the
// route-level end-to-end coverage.
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectCalendarLoadSubject } = require('../src/intelligence/open-question-subject');

function load(hours, overrides = {}) {
  return { meetingHours: hours, degraded: false, overlapTitleFor: () => null, ...overrides };
}

test('detectCalendarLoadSubject: matches a question citing TODAY\'s exact figure', () => {
  const workBusy = [{ id: 'work_busy_2026-07-24_0900-1800', start: '9:00 AM', end: '6:00 PM' }];
  const out = detectCalendarLoadSubject('You have 9.0 hours of meetings today — anything driving that?', {
    todayLoad: load(9.0), tomorrowLoad: load(2.0), todayKey: '2026-07-24', tomorrowKey: '2026-07-25',
    todayWorkBusy: workBusy, tomorrowWorkBusy: [],
  });
  assert.ok(out);
  assert.equal(out.subjectType, 'calendar_load');
  assert.equal(out.subjectLocalDate, '2026-07-24');
  assert.deepEqual(out.blockIds, ['work_busy_2026-07-24_0900-1800']);
  assert.equal(out.ambiguous, false);
});

test('detectCalendarLoadSubject: "tomorrow" wording binds to tomorrow\'s figure even if today is a coincidental near-match', () => {
  const tomorrowWorkBusy = [{ id: 'blk-tmr', start: '10:00 AM', end: '7:00 PM' }];
  const out = detectCalendarLoadSubject('You have 9 hours of meetings tomorrow — anything driving that?', {
    todayLoad: load(9.1), tomorrowLoad: load(9.0), todayKey: '2026-07-24', tomorrowKey: '2026-07-25',
    todayWorkBusy: [{ id: 'blk-today', start: '9:00 AM', end: '6:06 PM' }], tomorrowWorkBusy,
  });
  assert.ok(out);
  assert.equal(out.subjectLocalDate, '2026-07-25');
  assert.deepEqual(out.blockIds, ['blk-tmr']);
});

test('detectCalendarLoadSubject: no day word and both days match ambiguously -> null (never guesses which day)', () => {
  const out = detectCalendarLoadSubject('You have 9 hours of meetings — anything driving that?', {
    todayLoad: load(9.0), tomorrowLoad: load(9.1), todayKey: '2026-07-24', tomorrowKey: '2026-07-25',
    todayWorkBusy: [{ id: 'a', start: '9:00 AM', end: '6:00 PM' }], tomorrowWorkBusy: [{ id: 'b', start: '9:00 AM', end: '6:06 PM' }],
  });
  assert.equal(out, null);
});

test('detectCalendarLoadSubject: no meeting-load keyword -> null even with a matching number', () => {
  const out = detectCalendarLoadSubject('Your recovery score is 9 today — feeling ok?', {
    todayLoad: load(9.0), todayKey: '2026-07-24', todayWorkBusy: [{ id: 'a', start: '9:00 AM', end: '6:00 PM' }],
  });
  assert.equal(out, null);
});

test('detectCalendarLoadSubject: no numeric hour figure -> null', () => {
  const out = detectCalendarLoadSubject('Your calendar looks pretty busy today — anything driving that?', {
    todayLoad: load(9.0), todayKey: '2026-07-24', todayWorkBusy: [{ id: 'a', start: '9:00 AM', end: '6:00 PM' }],
  });
  assert.equal(out, null);
});

test('detectCalendarLoadSubject: figure outside tolerance of both days -> null', () => {
  const out = detectCalendarLoadSubject('You have 3 hours of meetings today — anything driving that?', {
    todayLoad: load(9.0), tomorrowLoad: load(2.0), todayKey: '2026-07-24', tomorrowKey: '2026-07-25',
    todayWorkBusy: [{ id: 'a', start: '9:00 AM', end: '6:00 PM' }], tomorrowWorkBusy: [],
  });
  assert.equal(out, null);
});

test('detectCalendarLoadSubject: a degraded load is never matched (no reliable figure to cite)', () => {
  const out = detectCalendarLoadSubject('You have 9 hours of meetings today — anything driving that?', {
    todayLoad: load(9.0, { degraded: true, meetingHours: null }), todayKey: '2026-07-24',
    todayWorkBusy: [{ id: 'a', start: '9:00 AM', end: '6:00 PM' }],
  });
  assert.equal(out, null);
});

test('detectCalendarLoadSubject: multiple candidate blocks with one clearly dominant -> unambiguous, bound to the dominant one', () => {
  // 8h dominant block + a 15-minute sliver -> dominant wins (>=60% of total).
  const workBusy = [
    { id: 'big', start: '9:00 AM', end: '5:00 PM' },
    { id: 'small', start: '5:00 PM', end: '5:15 PM' },
  ];
  const out = detectCalendarLoadSubject('You have 8.3 hours of meetings today — anything driving that?', {
    todayLoad: load(8.25), todayKey: '2026-07-24', todayWorkBusy: workBusy,
  });
  assert.ok(out);
  assert.deepEqual(out.blockIds, ['big']);
  assert.equal(out.ambiguous, false);
});

test('detectCalendarLoadSubject: multiple comparably-sized blocks with no dominant one -> ambiguous, all candidate ids returned', () => {
  const workBusy = [
    { id: 'first', start: '9:00 AM', end: '1:00 PM' },
    { id: 'second', start: '2:00 PM', end: '6:00 PM' },
  ];
  const out = detectCalendarLoadSubject('You have 8.0 hours of meetings today — anything driving that?', {
    todayLoad: load(8.0), todayKey: '2026-07-24', todayWorkBusy: workBusy,
  });
  assert.ok(out);
  assert.equal(out.ambiguous, true);
  assert.deepEqual(out.blockIds.sort(), ['first', 'second']);
});

test('detectCalendarLoadSubject: a block already netted against a named personal event does not count as a candidate', () => {
  const netted = { id: 'netted', start: '9:00 AM', end: '6:00 PM' };
  const real = { id: 'real', start: '6:00 PM', end: '9:00 PM' };
  const out = detectCalendarLoadSubject('You have 3.0 hours of meetings today — anything driving that?', {
    todayLoad: load(3.0, { overlapTitleFor: (b) => (b.id === 'netted' ? 'Personal event' : null) }),
    todayKey: '2026-07-24', todayWorkBusy: [netted, real],
  });
  assert.ok(out);
  assert.deepEqual(out.blockIds, ['real']);
});

test('detectCalendarLoadSubject: no resolvable candidate blocks -> null (nothing to bind)', () => {
  const out = detectCalendarLoadSubject('You have 9 hours of meetings today — anything driving that?', {
    todayLoad: load(9.0), todayKey: '2026-07-24', todayWorkBusy: [],
  });
  assert.equal(out, null);
});
