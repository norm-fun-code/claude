// naiveToUtcIso was a private helper inline in server.js (used by GET
// /api/annotations and one other route), now promoted to a shared, exported
// utility in src/util/date.js as part of the server.js decomposition — moved
// here instead of duplicated into the new annotations router, since two
// call sites need it. Previously untested; adding coverage now that it's a
// proper shared function.
const test = require('node:test');
const assert = require('node:assert/strict');
const { naiveToUtcIso, localDayBoundsUtc } = require('../src/util/date');

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
