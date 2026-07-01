const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSignals } = require('../src/intelligence/pre-brief-signals');

// Regression test: workBusy/calendar times arrive as bare 12-hour strings
// ("2:00 PM"), which `new Date(...)` can't parse — the old implementation
// silently computed 0 meeting-minutes forever, so this signal never fired.

test('packed_calendar fires when work-busy blocks total >= 4h', () => {
  const workBusy = [
    { start: '9:00 AM', end: '12:00 PM' },
    { start: '1:00 PM', end: '3:00 PM' },
  ];
  const signals = buildSignals({ recovery: null, workBusy, calendar: [] });
  const packed = signals.find((s) => s.key === 'packed_calendar');
  assert.ok(packed, 'packed_calendar should fire for 5 hours of meetings');
  assert.match(packed.question, /5\.0h/);
});

test('packed_calendar does not fire under the 4h threshold', () => {
  const workBusy = [{ start: '9:00 AM', end: '11:00 AM' }];
  const signals = buildSignals({ recovery: null, workBusy, calendar: [] });
  assert.equal(signals.find((s) => s.key === 'packed_calendar'), undefined);
});

test('packed_calendar correctly sums time crossing the noon boundary (AM/PM parsing)', () => {
  // 11:00 AM - 4:00 PM must be read as 5 hours, not treated as if PM < AM.
  const workBusy = [{ start: '11:00 AM', end: '4:00 PM' }];
  const signals = buildSignals({ recovery: null, workBusy, calendar: [] });
  const packed = signals.find((s) => s.key === 'packed_calendar');
  assert.ok(packed);
  assert.match(packed.question, /5\.0h/);
});

test('personal calendar events also count toward meeting time', () => {
  const calendar = [
    { allDay: false, startTime: '2:00 PM', endTime: '6:30 PM', title: 'Offsite' },
  ];
  const signals = buildSignals({ recovery: null, workBusy: [], calendar });
  const packed = signals.find((s) => s.key === 'packed_calendar');
  assert.ok(packed, 'a single 4.5h calendar event should trip the threshold');
});

test('all-day calendar events are excluded from meeting time', () => {
  const calendar = [{ allDay: true, startTime: null, endTime: null, title: 'Vacation' }];
  const signals = buildSignals({ recovery: null, workBusy: [], calendar });
  assert.equal(signals.find((s) => s.key === 'packed_calendar'), undefined);
});

test('recovery_low and spending_spike are unaffected by the calendar fix', () => {
  const signals = buildSignals({ recovery: { score: 42 }, spend: 200, spendBaseline: 50 });
  assert.ok(signals.find((s) => s.key === 'recovery_low'));
  assert.ok(signals.find((s) => s.key === 'spending_spike'));
});
