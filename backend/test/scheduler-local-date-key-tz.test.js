// localDateKey drives the morning-routine's per-day dedup marker
// (morningKey/markMorningRan/morningRanToday). It was implemented with
// d.getFullYear()/getMonth()/getDate() — correct only if the OS-level TZ env
// var happens to match the configured TZ; its own doc comment claimed
// "(TZ-aware)" but the body never actually consulted the tz. Now resolves
// explicitly via toLocaleDateString with an explicit timeZone, independent
// of the process's own local time setting.
const test = require('node:test');
const assert = require('node:assert/strict');
const { localDateKey } = require('../src/scheduler');

test('localDateKey resolves the correct Eastern calendar day for an evening instant near UTC midnight', () => {
  const prior = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    // 11pm ET on July 8 is 3am UTC on July 9.
    const key = localDateKey(new Date('2026-07-09T03:00:00Z'));
    assert.equal(key, '2026-07-08');
  } finally {
    process.env.TZ = prior;
  }
});

test('localDateKey defaults to America/New_York when TZ is unset (documented default, not process local time)', () => {
  const prior = process.env.TZ;
  delete process.env.TZ;
  try {
    const key = localDateKey(new Date('2026-07-09T03:00:00Z'));
    assert.equal(key, '2026-07-08');
  } finally {
    if (prior !== undefined) process.env.TZ = prior;
  }
});
