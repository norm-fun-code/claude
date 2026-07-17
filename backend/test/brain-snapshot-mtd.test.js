// Regression: canonicalSpendingMtd must INCLUDE the first day of the month.
// Wealth flow metrics are day-keyed at UTC midnight of the local day string
// (monarch.js dayTs: local July 1 -> 2026-07-01T00:00:00Z). Using
// localMonthStartUtc (true local midnight = 2026-07-01T04:00:00Z in EDT) as the
// `from` bound silently excludes the entire 1st of the month. The correct
// boundary is localMonthKeyStartUtc (2026-07-01T00:00:00Z). This test captures
// the exact `from` the aggregation is queried with and proves the July-1 key
// is on the included side of it.
const test = require('node:test');
const assert = require('node:assert/strict');

const metricsStore = require('../src/store/metrics');
const { canonicalSpendingMtd } = require('../src/brain/snapshot');
const { localMonthKeyStartUtc, localMonthStartUtc } = require('../src/util/date');

const TZ = 'America/New_York';
// Mid-July, mid-afternoon ET (well past the 1st) — the realistic "asOf" a brief
// is built at.
const ASOF = new Date('2026-07-15T18:00:00.000Z');
// The UTC instant a local-July-1 wealth metric is keyed at.
const JULY_1_KEY = new Date('2026-07-01T00:00:00.000Z');

test('canonicalSpendingMtd queries from the day-keyed month start (includes July 1), not true-local-midnight', async () => {
  const orig = metricsStore.dailyAggregate;
  let capturedFrom = null;
  // Return a July-1 row + a mid-month row; the sum should include BOTH.
  metricsStore.dailyAggregate = async ({ from }) => {
    capturedFrom = from;
    return [
      { day: '2026-07-01', value: 120 }, // the 1st — must be included
      { day: '2026-07-14', value: 80 },
    ];
  };
  try {
    const total = await canonicalSpendingMtd(ASOF, TZ);

    // The boundary must be the day-keyed month start (00:00Z), not the
    // true-local-midnight variant (04:00Z EDT) that would exclude July 1.
    assert.equal(capturedFrom.getTime(), localMonthKeyStartUtc(TZ, ASOF).getTime());
    assert.equal(capturedFrom.getTime(), JULY_1_KEY.getTime());

    // The July-1 key must fall ON or AFTER the query boundary (i.e. included).
    assert.ok(JULY_1_KEY.getTime() >= capturedFrom.getTime(),
      'July 1 metric key must be inside the MTD window');

    // And the buggy boundary would have EXCLUDED it — prove they differ.
    assert.ok(localMonthStartUtc(TZ, ASOF).getTime() > JULY_1_KEY.getTime(),
      'the old localMonthStartUtc boundary sits after the July-1 key (would exclude it)');

    // Both rows summed.
    assert.equal(total, 200);
  } finally {
    metricsStore.dailyAggregate = orig;
  }
});
