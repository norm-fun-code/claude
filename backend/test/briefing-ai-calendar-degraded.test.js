// Audit3 fix 4: a failed personal-calendar (or work free/busy) fetch used to
// be indistinguishable from "the source returned zero events" — both
// collapsed to an empty array, which can recreate the mirrored-Sabbath
// double-counting bug (a mirrored block has nothing to net against when the
// personal calendar silently reads as empty-but-successful). buildChiefBriefPrompt
// now takes an explicit calendarSourcesAvailable flag (see routes/briefing.js,
// threaded from Promise.allSettled status, never from array-emptiness) and
// must suppress any meeting-hours/packed/light claim when a required source
// didn't actually load.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChiefBriefPrompt } = require('../src/services/briefing-ai');

function prompt({ calendarEvents = [], workBusyBlocks = [], calendarSourcesAvailable = { workBusy: true, calendar: true } } = {}) {
  return buildChiefBriefPrompt(
    [], 'Friday', { type: 'Rest' }, calendarEvents,
    '', '', '', '', '', '',            // 5-10
    workBusyBlocks,                     // 11
    '', '', '', '', '', '', '', '', '', // 12-20
    [],                                  // 21 openGoals
    '',                                  // 22 recoveryDriversContext
    calendarSourcesAvailable            // 23
  );
}

test('personal calendar unavailable, work free/busy succeeded with heavy hours: no meeting-hours number is asserted', () => {
  const text = prompt({
    workBusyBlocks: [{ start: '9:00 AM', end: '5:00 PM' }], // 8h, would otherwise read as packed
    calendarEvents: [],
    calendarSourcesAvailable: { workBusy: true, calendar: false },
  });
  assert.match(text, /meeting-load data is INCOMPLETE/, 'must acknowledge the data gap');
  assert.doesNotMatch(text, /TOTAL MEETING LOAD TODAY/, 'must never cite an authoritative meeting-hours figure while the personal calendar is unavailable');
  assert.doesNotMatch(text, /8\.0h/, 'must not assert the raw work-busy hours as if they were the net, deduplicated total');
});

test('work free/busy unavailable, personal calendar succeeded: no meeting-hours number is asserted either', () => {
  const text = prompt({
    workBusyBlocks: [],
    calendarEvents: [{ title: 'Standup', startTime: '9:00 AM', endTime: '9:30 AM' }],
    calendarSourcesAvailable: { workBusy: false, calendar: true },
  });
  assert.match(text, /meeting-load data is INCOMPLETE/);
  assert.doesNotMatch(text, /TOTAL MEETING LOAD TODAY/);
});

test('both sources available with the same heavy load DOES cite an authoritative meeting-hours figure (sanity check)', () => {
  const text = prompt({
    workBusyBlocks: [{ start: '9:00 AM', end: '5:00 PM' }],
    calendarEvents: [],
    calendarSourcesAvailable: { workBusy: true, calendar: true },
  });
  assert.match(text, /TOTAL MEETING LOAD TODAY.*8\.0h/s, 'with both sources available, the genuine 8h load must be cited normally');
});

test('calendarSourcesAvailable defaults to fully-available when omitted (backward compatible)', () => {
  const text = prompt({ workBusyBlocks: [{ start: '9:00 AM', end: '11:00 AM' }] });
  assert.doesNotMatch(text, /meeting-load data is INCOMPLETE/);
});
