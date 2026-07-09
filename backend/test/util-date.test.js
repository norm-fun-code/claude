// naiveToUtcIso was a private helper inline in server.js (used by GET
// /api/annotations and one other route), now promoted to a shared, exported
// utility in src/util/date.js as part of the server.js decomposition — moved
// here instead of duplicated into the new annotations router, since two
// call sites need it. Previously untested; adding coverage now that it's a
// proper shared function.
const test = require('node:test');
const assert = require('node:assert/strict');
const { naiveToUtcIso } = require('../src/util/date');

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
