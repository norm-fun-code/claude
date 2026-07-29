// Bug report: "it builds the brief, I close the app, reopen it, and nothing
// is there." Part of the root cause: a build job can be orphaned "in
// flight" forever if the process that owned it crashes before marking it
// terminal. isJobStale is the pure staleness judgment routes/briefing.js's
// GET /briefing/rebuild/status uses to durably resolve one back to 'failed'
// instead of reporting "still building" indefinitely.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isJobStale, STALE_IN_FLIGHT_MS, IN_FLIGHT_STATES } = require('../src/store/morningBuildJobs');

const job = (state, updatedAgoMs) => ({
  id: 'job-1',
  state,
  updated_at: new Date(Date.now() - updatedAgoMs).toISOString(),
});

test('required: a recently-updated in-flight job is NOT stale — a genuinely running build must not be misdiagnosed', () => {
  assert.equal(isJobStale(job('building', 0)), false);
  assert.equal(isJobStale(job('building', STALE_IN_FLIGHT_MS - 1000)), false);
});

test('required: an in-flight job with no update for the full stale window IS stale', () => {
  assert.equal(isJobStale(job('building', STALE_IN_FLIGHT_MS)), true);
  assert.equal(isJobStale(job('building', STALE_IN_FLIGHT_MS + 60_000)), true);
});

test('required: staleness applies to every in-flight state, not just "building"', () => {
  for (const state of IN_FLIGHT_STATES) {
    assert.equal(isJobStale(job(state, STALE_IN_FLIGHT_MS + 1)), true, `${state} should be judged stale`);
  }
});

test('required: a terminal job (ready/failed) is never "stale" — staleness only judges in-flight rows', () => {
  assert.equal(isJobStale(job('ready', STALE_IN_FLIGHT_MS + 60_000)), false);
  assert.equal(isJobStale(job('failed', STALE_IN_FLIGHT_MS + 60_000)), false);
});

test('a custom threshold is respected', () => {
  assert.equal(isJobStale(job('building', 4_000), Date.now(), 5_000), false);
  assert.equal(isJobStale(job('building', 5_000), Date.now(), 5_000), true);
});

test('total and safe: null/malformed input never throws', () => {
  assert.equal(isJobStale(null), false);
  assert.equal(isJobStale({ state: 'building', updated_at: 'not-a-date' }), false);
  assert.equal(isJobStale({ state: 'building' }), false);
});
