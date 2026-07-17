// Live bug found via a product review: the Brief still said "8.5h of
// meetings ahead" on a day with a Sabbath observance, even after the
// personal-calendar Sabbath block was already excluded from "heavy calendar"
// framing (see the RELAY/personal-calendar rules in briefing-ai.js). Root
// cause: the Sabbath block was ALSO mirrored onto the work calendar as an
// anonymous busy chunk (free/busy feeds carry no titles) — the model had no
// way to know that untitled work-busy block was the SAME commitment already
// named on the personal calendar, so it summed it into "meetings" anyway.
// buildChiefBriefPrompt now cross-references workBusyBlocks against named
// calendarEvents by time overlap and annotates any match inline.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChiefBriefPrompt } = require('../src/services/briefing-ai');

function prompt({ calendarEvents = [], workBusyBlocks = [] } = {}) {
  return buildChiefBriefPrompt(
    [], 'Friday', { type: 'Rest' }, calendarEvents,
    '', '', '', '', '', '', workBusyBlocks
  );
}

test('a work-busy block overlapping a named personal event is annotated as the same commitment', () => {
  const text = prompt({
    calendarEvents: [{ title: 'Sabbath', startTime: '5:00 PM', endTime: '9:00 PM' }],
    workBusyBlocks: [
      { start: '9:00 AM', end: '1:30 PM' },
      { start: '5:00 PM', end: '9:00 PM' },
    ],
  });
  assert.match(text, /9:00 AM–1:30 PM,/, 'the real-meeting block must NOT carry an annotation');
  assert.doesNotMatch(text.split('9:00 AM–1:30 PM')[1].split(',')[0], /Sabbath/);
  assert.match(
    text,
    /5:00 PM–9:00 PM \(matches your personal calendar's "Sabbath" — not a real meeting, do not count toward meeting load\)/
  );
});

test('a partial-overlap work-busy block is still annotated (any real overlap counts)', () => {
  const text = prompt({
    calendarEvents: [{ title: 'Sabbath', startTime: '5:00 PM', endTime: '9:00 PM' }],
    workBusyBlocks: [{ start: '4:30 PM', end: '6:00 PM' }],
  });
  assert.match(text, /4:30 PM–6:00 PM \(matches your personal calendar's "Sabbath"/);
});

test('a work-busy block with no overlapping personal event carries no annotation', () => {
  const text = prompt({
    calendarEvents: [{ title: 'Dentist', startTime: '11:00 AM', endTime: '12:00 PM' }],
    workBusyBlocks: [{ start: '2:00 PM', end: '3:00 PM' }],
  });
  // "Dentist" legitimately appears in the personal-calendar listing above —
  // assert it's specifically ABSENT from the MEETINGS line's annotation, not
  // absent from the whole prompt.
  assert.match(text, /MEETINGS \(busy — no titles\): 2:00 PM–3:00 PM\n/);
});

test('an all-day personal event never matches (excluded from overlap matching, not a timed block)', () => {
  const text = prompt({
    calendarEvents: [{ title: 'Out of Town', allDay: true }],
    workBusyBlocks: [{ start: '2:00 PM', end: '3:00 PM' }],
  });
  assert.match(text, /MEETINGS \(busy — no titles\): 2:00 PM–3:00 PM\n/);
  assert.doesNotMatch(text, /Out of Town.*matches/);
});

test('with no work-busy blocks at all, the annotation logic never runs (no crash, unchanged message)', () => {
  const text = prompt({ calendarEvents: [{ title: 'Sabbath', startTime: '5:00 PM', endTime: '9:00 PM' }], workBusyBlocks: [] });
  assert.match(text, /No busy blocks visible/);
});

// ── classifiedOverrides (harden pass, item 3a) ────────────────────────────
// A calendar-classification correction ("that's a Sabbath block, not
// meetings") matched by context-resolver.js's matchCalendarClassifications
// must change the ACTUAL "TOTAL MEETING LOAD TODAY" figure the model reads —
// not just be excluded via a personal-calendar title match (the prior two
// tests already cover that path). This proves an override applies even for a
// work-busy block with NO corresponding named personal-calendar event at
// all — the case a raw calendar title match can never catch.

function promptWithOverrides({ calendarEvents = [], workBusyBlocks = [], classifiedOverrides = [] } = {}) {
  return buildChiefBriefPrompt(
    [], 'Friday', { type: 'Rest' }, calendarEvents,
    '', '', '', '', '', '', workBusyBlocks,
    '', '', '', '', '', '', '', '', '', [], '',
    { workBusy: true, calendar: true }, '', classifiedOverrides
  );
}

test('classifiedOverrides: reclassified work-busy block with no matching personal-calendar event is netted out of TOTAL MEETING LOAD', () => {
  const workBusyBlocks = [{ start: '9:00 AM', end: '10:00 AM' }, { start: '5:00 PM', end: '9:00 PM' }];
  const withoutOverride = promptWithOverrides({ calendarEvents: [], workBusyBlocks });
  assert.match(withoutOverride, /TOTAL MEETING LOAD TODAY[^:]*: 5\.0h/);

  const withOverride = promptWithOverrides({
    calendarEvents: [], workBusyBlocks,
    classifiedOverrides: [{ title: 'a Sabbath observance, not meetings', startTime: '5:00 PM', endTime: '9:00 PM', allDay: false }],
  });
  assert.match(withOverride, /TOTAL MEETING LOAD TODAY[^:]*: 1\.0h/);
  assert.match(withOverride, /matches your personal calendar's "a Sabbath observance, not meetings"/);
});
