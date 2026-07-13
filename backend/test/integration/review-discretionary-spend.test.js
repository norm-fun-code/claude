// Bug: the weekly review narrated "Spending basically vanished ($1,389
// total, -81%)" purely because rent landed the PRIOR week, not because the
// user's actual spending behavior changed. gatherWeek()'s KEY_METRICS fed
// the LLM BOTH wealth:spending (the raw total, including rent/fixed costs)
// and wealth:spending_discretionary, and the model picked the noisier,
// rent-distorted total for its narrative. Fixed by dropping raw `spending`
// from KEY_METRICS entirely — spending_discretionary (total minus fixed
// housing) is the only spending figure that reflects real behavior change,
// so it's the only one the review can ever cite.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const metricsStore = require('../../src/store/metrics');
const sourcesStore = require('../../src/store/sources');
const { gatherWeek } = require('../../src/intelligence/review');

const SOURCE = `test-review-discretionary-${Date.now()}`;

test.before(async () => {
  await sourcesStore.registerSource({ id: SOURCE, domain: 'wealth', displayName: 'Review discretionary test' });
});

afterEach(async () => {
  await db.query(`DELETE FROM metrics WHERE source = $1`, [SOURCE]);
});
after(async () => { await closeDb(); });

test('gatherWeek surfaces spending_discretionary but never the raw rent-distorted spending total', async () => {
  const asOf = new Date('2026-07-13T12:00:00Z');
  // A week with rent (5695) + a little discretionary (something small) —
  // the exact shape that made total spend swing wildly week to week purely
  // from rent timing.
  await metricsStore.insertMetrics([
    { ts: new Date('2026-07-08T12:00:00Z'), domain: 'wealth', metric: 'spending', value: 5825, source: SOURCE },
    { ts: new Date('2026-07-08T12:00:00Z'), domain: 'wealth', metric: 'spending_discretionary', value: 130, source: SOURCE },
  ]);

  const ctx = await gatherWeek(asOf);
  const labels = ctx.metrics.map((m) => m.label);
  assert.ok(labels.includes('Discretionary spending'), 'spending_discretionary must be present');
  assert.ok(!labels.includes('Spending'), 'the raw, fixed-cost-inflated spending total must never reach the review');
});
