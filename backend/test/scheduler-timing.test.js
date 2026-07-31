// Scheduler wall-clock regressions. These tests use fixed instants rather than
// the host process timezone: Railway may run in UTC while NormOS schedules in
// the user's configured timezone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextScheduledAt, msUntil, localClock } = require('../src/scheduler');

const ET = 'America/New_York';

test('daily scheduling re-arms at the same New York wall time across spring DST', () => {
  // 08:31 EST on Saturday. A fixed 24h timer would fire at 09:30 EDT Sunday.
  const now = new Date('2026-03-07T13:31:00.000Z');
  const next = nextScheduledAt(8, 30, null, { now, tz: ET });

  assert.equal(next.toISOString(), '2026-03-08T12:30:00.000Z');
  assert.deepEqual(localClock(next, ET), { ymd: '2026-03-08', hour: 8, minute: 30, weekday: 0 });
  assert.equal(msUntil(8, 30, null, { now, tz: ET }), next - now);
});

test('daily scheduling re-arms at the same New York wall time across fall DST', () => {
  // 08:31 EDT on Saturday. A fixed 24h timer would fire at 07:30 EST Sunday.
  const now = new Date('2026-10-31T12:31:00.000Z');
  const next = nextScheduledAt(8, 30, null, { now, tz: ET });

  assert.equal(next.toISOString(), '2026-11-01T13:30:00.000Z');
  assert.deepEqual(localClock(next, ET), { ymd: '2026-11-01', hour: 8, minute: 30, weekday: 0 });
});

test('weekly scheduling uses the configured local weekday, not the host UTC day', () => {
  // This is Saturday morning in New York. The weekly job must select Sunday
  // at 08:30 local regardless of the process timezone.
  const now = new Date('2026-07-04T13:00:00.000Z');
  const next = nextScheduledAt(8, 30, 0, { now, tz: ET });

  assert.equal(next.toISOString(), '2026-07-05T12:30:00.000Z');
  assert.deepEqual(localClock(next, ET), { ymd: '2026-07-05', hour: 8, minute: 30, weekday: 0 });
});

test('a New York morning is not treated as the next UTC calendar day', () => {
  // 10pm Wednesday in New York is already Thursday in UTC. The next 08:30
  // must still be Thursday morning local, not Friday.
  const now = new Date('2026-07-30T02:00:00.000Z');
  const next = nextScheduledAt(8, 30, null, { now, tz: ET });

  assert.equal(next.toISOString(), '2026-07-30T12:30:00.000Z');
  assert.deepEqual(localClock(next, ET), { ymd: '2026-07-30', hour: 8, minute: 30, weekday: 4 });
});
