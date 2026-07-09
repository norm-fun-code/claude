// endOfTomorrowET used d.setDate(d.getDate()+1); d.setHours(23,59,59,0) —
// server-process-local arithmetic despite a doc comment claiming ET, and an
// unused ET_TZ constant sitting right next to it. Now resolves the +1 day
// via UTC calendar arithmetic (immune to DST) and anchors 23:59:59.999
// explicitly in America/New_York via naiveToUtcIso.
const test = require('node:test');
const assert = require('node:assert/strict');
const { endOfTomorrowET } = require('../src/store/annotations');

test('endOfTomorrowET resolves tomorrow correctly for an evening-ET instant near UTC midnight', () => {
  // 11pm ET on July 8 is 3am UTC on July 9 — "tomorrow" (ET) must be July 9,
  // not July 10 (which a naive UTC-day read of the instant would produce).
  const result = endOfTomorrowET(new Date('2026-07-09T03:00:00Z'));
  // 23:59:59.999 ET on 2026-07-09 (EDT, UTC-4) = 2026-07-10T03:59:59.999Z
  assert.equal(result.toISOString(), '2026-07-10T03:59:59.999Z');
});

test('endOfTomorrowET handles a month rollover correctly', () => {
  const result = endOfTomorrowET(new Date('2026-07-31T12:00:00Z')); // noon ET July 31
  // Tomorrow (ET) = Aug 1; 23:59:59.999 ET on Aug 1 (EDT, UTC-4) = Aug 2 UTC.
  assert.equal(result.toISOString(), '2026-08-02T03:59:59.999Z');
});

test('endOfTomorrowET is correct across a DST transition (winter, EST = UTC-5)', () => {
  const result = endOfTomorrowET(new Date('2026-01-15T12:00:00Z'));
  // Tomorrow = 2026-01-16, 23:59:59.999 EST = 2026-01-17T04:59:59.999Z
  assert.equal(result.toISOString(), '2026-01-17T04:59:59.999Z');
});
