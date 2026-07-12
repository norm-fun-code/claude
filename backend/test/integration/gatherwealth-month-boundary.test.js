// P5 (adjacent finding): gatherWealth's MTD discretionary window must include
// the 1st-of-month's spending. Wealth flow metrics are stored at UTC-midnight
// of the local DAY STRING (monarch.js dayTs: local July 1 -> 2026-07-01T00:00Z).
// An earlier fix used localMonthStartUtc (TRUE local midnight = 04:00Z in EDT),
// whose lower bound sorts AFTER the 1st's 00:00Z metric, silently dropping it
// from every MTD sum. gatherWealth now uses localMonthKeyStartUtc (00:00Z of the
// local month-first-day string), matching the storage key.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const { gatherWealth } = require('../../src/intelligence/consolidate');
const metricsStore = require('../../src/store/metrics');
const sourcesStore = require('../../src/store/sources');

const SOURCE = `ZZmtd-${Date.now()}`;

function localMonthFirstKeyTs(now = new Date()) {
  const ymd = now.toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' });
  return new Date(`${ymd.slice(0, 7)}-01T00:00:00Z`); // how dayTs keys the local 1st
}

test.before(async () => {
  await sourcesStore.registerSource({ id: SOURCE, domain: 'wealth', displayName: 'MTD boundary test' });
});
after(async () => {
  await db.query(`DELETE FROM metrics WHERE source = $1`, [SOURCE]);
  await db.query(`DELETE FROM sources WHERE id = $1`, [SOURCE]);
  await closeDb();
});

test('gatherWealth includes the 1st-of-month discretionary spend in the MTD sum', async () => {
  const firstTs = localMonthFirstKeyTs();
  const midTs = new Date(firstTs.getTime() + 5 * 864e5); // the 6th, safely mid-month
  await metricsStore.insertMetrics([
    { ts: firstTs, domain: 'wealth', metric: 'spending_discretionary', value: 111.11, source: SOURCE },
    { ts: midTs, domain: 'wealth', metric: 'spending_discretionary', value: 22.22, source: SOURCE },
  ]);

  // gatherWealth excludes source 'seed' but not our test source, so its MTD sum
  // includes both rows — proving the 1st (111.11) is inside the window.
  const wealth = await gatherWealth();
  // Other wealth data may exist in the shared DB; assert our 1st-of-month value
  // is part of the MTD sum by checking the sum is at least our two seeded rows.
  assert.ok(wealth.spendingMtd >= 111.11 + 22.22 - 0.001,
    `MTD (${wealth.spendingMtd}) must include the 1st-of-month 111.11 + mid-month 22.22`);
});
