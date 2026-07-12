// Integration coverage for recomputeWealthFlows() — the tool that rebuilds
// spending/spending_discretionary/income/net_cashflow from the authoritative
// documents table when they've drifted from a sync run that (for whatever
// reason — a partial fetch, an old bug, a failed background recompute)
// stored a stale/incomplete aggregate. Exercises the new sinceDate scoping,
// which bounds both the document read and the metric delete so a full
// unbounded rebuild doesn't have to scan the entire documents table.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { recomputeWealthFlows } = require('../../src/services/recompute-wealth');
const { upsertDocument } = require('../../src/store/documents');
const metricsStore = require('../../src/store/metrics');
const sourcesStore = require('../../src/store/sources');
const { closeDb } = require('./helpers');

afterEach(async () => {
  await db.query(`DELETE FROM documents WHERE source = 'monarch' AND domain = 'wealth' AND external_id LIKE 'recompute-test:%'`);
  await db.query(`DELETE FROM metrics WHERE source = 'monarch' AND domain = 'wealth' AND metric = ANY($1) AND ts BETWEEN '2025-01-01' AND '2027-01-01'`, [['spending', 'spending_discretionary', 'income', 'net_cashflow']]);
});

after(async () => {
  await closeDb();
});

test.before(async () => {
  await sourcesStore.registerSource({ id: 'monarch', domain: 'wealth', displayName: 'Monarch (CSV import)' });
});

async function seedTxnDoc({ id, date, amount, category, merchant = 'Test Merchant' }) {
  await upsertDocument({
    source: 'monarch',
    domain: 'wealth',
    externalId: `recompute-test:${id}`,
    title: merchant,
    content: `${merchant} — ${category} — $${amount}`,
    occurredAt: date,
    metadata: { amount, category, account: 'Checking', merchant },
  });
}

test('recomputeWealthFlows rebuilds stale flow metrics from the documents table', async () => {
  await seedTxnDoc({ id: 'r1', date: '2026-07-01', amount: -4409.03, category: 'Rent' });
  await seedTxnDoc({ id: 'r2', date: '2026-07-01', amount: -50, category: 'Groceries' });
  // Simulate a prior sync that stored a WRONG (too-low) value for the day —
  // exactly the drift this tool exists to correct.
  await metricsStore.insertMetrics([
    { ts: new Date('2026-07-01T12:00:00Z'), domain: 'wealth', metric: 'spending', value: 50, source: 'monarch' },
  ]);

  const result = await recomputeWealthFlows({ sinceDate: '2026-06-01' });
  assert.equal(result.metricsWritten > 0, true);

  const { rows } = await db.query(
    `SELECT value FROM metrics WHERE domain='wealth' AND metric='spending' AND source='monarch' AND (ts AT TIME ZONE 'UTC')::date = '2026-07-01'`
  );
  assert.equal(Number(rows[0].value), 4459.03, 'the rebuilt total must include the previously-missing Rent transaction');
});

test('sinceDate scoping leaves metrics OUTSIDE the window untouched', async () => {
  await seedTxnDoc({ id: 'r3', date: '2026-03-01', amount: -999, category: 'Groceries' });
  await metricsStore.insertMetrics([
    { ts: new Date('2026-03-01T12:00:00Z'), domain: 'wealth', metric: 'spending', value: 111, source: 'monarch' },
  ]);

  // Recompute scoped to July only — March must be left exactly as it was.
  await recomputeWealthFlows({ sinceDate: '2026-07-01' });

  const { rows } = await db.query(
    `SELECT value FROM metrics WHERE domain='wealth' AND metric='spending' AND source='monarch' AND (ts AT TIME ZONE 'UTC')::date = '2026-03-01'`
  );
  assert.equal(Number(rows[0].value), 111, 'a day outside sinceDate must not be touched by a scoped recompute');
});

test('an unscoped recompute (no sinceDate) still processes full history, preserving prior behavior', async () => {
  await seedTxnDoc({ id: 'r4', date: '2026-02-01', amount: -75, category: 'Dining' });
  const result = await recomputeWealthFlows();
  const { rows } = await db.query(
    `SELECT value FROM metrics WHERE domain='wealth' AND metric='spending' AND source='monarch' AND (ts AT TIME ZONE 'UTC')::date = '2026-02-01'`
  );
  assert.equal(Number(rows[0].value), 75);
  assert.ok(result.transactions >= 1);
});
