// naiveToUtcIso was a private helper inline in server.js (used by GET
// /api/annotations and one other route), now promoted to a shared, exported
// utility in src/util/date.js as part of the server.js decomposition — moved
// here instead of duplicated into the new annotations router, since two
// call sites need it. Previously untested; adding coverage now that it's a
// proper shared function.
const test = require('node:test');
const assert = require('node:assert/strict');
const { naiveToUtcIso, localDayBoundsUtc, localMonthStartUtc, localMonthKeyStartUtc } = require('../src/util/date');

test('a naive datetime string in Eastern time converts to the correct UTC instant', () => {
  // Midnight Eastern on a summer date (EDT, UTC-4) = 4am UTC.
  const iso = naiveToUtcIso('2026-07-15T00:00:00', 'America/New_York');
  assert.equal(iso, '2026-07-15T04:00:00.000Z');
});

test('a naive datetime string in winter (EST, UTC-5) converts correctly', () => {
  const iso = naiveToUtcIso('2026-01-15T00:00:00', 'America/New_York');
  assert.equal(iso, '2026-01-15T05:00:00.000Z');
});

test('a string that already has a Z suffix passes through unchanged', () => {
  const iso = naiveToUtcIso('2026-07-15T04:00:00.000Z', 'America/New_York');
  assert.equal(iso, '2026-07-15T04:00:00.000Z');
});

test('a string with an explicit offset passes through unchanged', () => {
  const iso = naiveToUtcIso('2026-07-15T00:00:00-04:00', 'America/New_York');
  assert.equal(iso, '2026-07-15T00:00:00-04:00');
});

test('null/undefined/empty input passes through unchanged (falsy short-circuit)', () => {
  assert.equal(naiveToUtcIso(null, 'America/New_York'), null);
  assert.equal(naiveToUtcIso(undefined, 'America/New_York'), undefined);
  assert.equal(naiveToUtcIso('', 'America/New_York'), '');
});

test('works correctly for a non-Eastern timezone too (Pacific)', () => {
  const iso = naiveToUtcIso('2026-07-15T00:00:00', 'America/Los_Angeles');
  assert.equal(iso, '2026-07-15T07:00:00.000Z'); // PDT = UTC-7
});

// localDayBoundsUtc replaces `new Date(now.getFullYear(), now.getMonth(),
// now.getDate(), 0,0,0)` — the server-process-local pattern that silently
// used the wrong day whenever the OS-level TZ env var didn't match the
// user's actual timezone (see the "recurring timezone-boundary bug" class
// found across calendar.js/annotations.js/consolidate.js/watch.js).
test('localDayBoundsUtc resolves the correct local day for an evening-ET instant near UTC midnight', () => {
  // 11pm ET on July 8 is 3am UTC on July 9 — a naive server-local Date getter
  // running in UTC would compute "today" as July 9, not July 8.
  const now = new Date('2026-07-09T03:00:00Z');
  const { start, end } = localDayBoundsUtc('America/New_York', now);
  assert.equal(start.toISOString(), '2026-07-08T04:00:00.000Z'); // midnight ET (EDT, UTC-4)
  assert.equal(end.toISOString().slice(0, 10), '2026-07-09'); // 23:59:59.999 ET crosses into the 9th UTC
  assert.ok(start.getTime() < now.getTime() && now.getTime() < end.getTime(), 'now must fall inside its own local-day bounds');
});

test('localDayBoundsUtc is correct across a DST boundary (winter, EST = UTC-5)', () => {
  const { start } = localDayBoundsUtc('America/New_York', new Date('2026-01-15T12:00:00Z'));
  assert.equal(start.toISOString(), '2026-01-15T05:00:00.000Z');
});

// Bug bash finding: consolidate.js's gatherWealth() computed "MTD" via
// Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) — the UTC calendar
// month, not the user's LOCAL one. This silently shifts which days count as
// "this month" for several hours around every month boundary.
test('localMonthStartUtc resolves the LOCAL month start, not the UTC one, in the first hours of a new UTC month', () => {
  // 8pm ET on July 31 is midnight UTC on August 1 — the UTC calendar has
  // already rolled to August while it's still July in New York. A UTC-based
  // month boundary would wrongly exclude the rest of July's MTD spending.
  const now = new Date('2026-08-01T00:30:00Z'); // July 31, 8:30pm EDT
  const monthStart = localMonthStartUtc('America/New_York', now);
  assert.equal(monthStart.toISOString(), '2026-07-01T04:00:00.000Z'); // midnight ET, July 1 (EDT, UTC-4)
  assert.ok(monthStart.getTime() < now.getTime(), 'the still-July instant must fall AFTER July\'s local month start');
});

test('localMonthStartUtc resolves the new LOCAL month promptly after it actually begins locally', () => {
  // Midnight ET on August 1 is 4am UTC — still August 1 in UTC too here, no
  // boundary ambiguity; this just pins down the ordinary case.
  const now = new Date('2026-08-01T10:00:00Z'); // 6am EDT, August 1
  const monthStart = localMonthStartUtc('America/New_York', now);
  assert.equal(monthStart.toISOString(), '2026-08-01T04:00:00.000Z');
});

test('localMonthStartUtc is correct across a DST boundary (winter, EST = UTC-5)', () => {
  const monthStart = localMonthStartUtc('America/New_York', new Date('2026-01-15T12:00:00Z'));
  assert.equal(monthStart.toISOString(), '2026-01-01T05:00:00.000Z');
});

// localMonthKeyStartUtc matches the WEALTH FLOW metric storage key: those are
// stored at UTC-midnight of the local DAY STRING (monarch.js dayTs), so a local
// July-1 metric is at 2026-07-01T00:00:00Z — NOT true local midnight (04:00Z).
// The month boundary for selecting those metrics must therefore be 00:00:00Z of
// the local month-first-day string, or the 1st-of-month's metric is excluded.
test('localMonthKeyStartUtc returns UTC-midnight of the LOCAL month-first-day string (matches wealth metric keys)', () => {
  // Still July locally at 8:30pm ET on the 31st (already Aug 1 in UTC): the LOCAL
  // month is July, so the key start must be 2026-07-01T00:00:00Z.
  const now = new Date('2026-08-01T00:30:00Z'); // July 31, 8:30pm EDT
  assert.equal(localMonthKeyStartUtc('America/New_York', now).toISOString(), '2026-07-01T00:00:00.000Z');
});

test('localMonthKeyStartUtc includes the 1st-of-month wealth metric that localMonthStartUtc would drop', () => {
  const now = new Date('2026-07-15T12:00:00Z');
  const july1Metric = new Date('2026-07-01T00:00:00Z'); // how dayTs stores local July 1
  assert.equal(july1Metric >= localMonthKeyStartUtc('America/New_York', now), true, 'included by the key-start');
  assert.equal(july1Metric >= localMonthStartUtc('America/New_York', now), false, 'localMonthStartUtc (04:00Z) wrongly excludes it');
});
