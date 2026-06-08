// One-time maintenance: rebuild the daily wealth FLOW metrics (spending,
// spending_discretionary, income, net_cashflow) from the stored Monarch
// transaction documents, applying the CURRENT mapTransactions rules — which now
// exclude internal transfers and credit-card payments.
//
// Why this is needed: the Monarch sync hashes each CSV and skips unchanged
// files, so simply re-syncing won't rewrite historical metric rows that were
// computed under the old (transfer-inflated) logic. The transaction documents,
// however, persist every transaction, so we can faithfully recompute from them.
const { query } = require('../db');
const metricsStore = require('../store/metrics');
const { mapTransactions } = require('../connectors/monarch');

const FLOW_METRICS = ['spending', 'spending_discretionary', 'income', 'net_cashflow'];

async function recomputeWealthFlows() {
  // 1) Pull every stored Monarch transaction (documents preserve full history).
  const { rows } = await query(
    `SELECT occurred_at, metadata
       FROM documents
      WHERE source = 'monarch' AND domain = 'wealth' AND metadata ? 'amount'`
  );

  // 2) Reconstruct records mapTransactions understands (field() matches on
  //    normalized header names, so these canonical keys resolve cleanly).
  // Safety: never wipe flow metrics off the back of an empty/failed read — if
  // there are no transaction documents, leave existing metrics untouched.
  if (rows.length === 0) return { transactions: 0, metricsWritten: 0, skipped: 'no transactions' };

  const records = rows.map((r) => ({
    date: (r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at)).slice(0, 10),
    amount: r.metadata.amount,
    category: r.metadata.category || '',
    account: r.metadata.account || '',
    merchant: r.metadata.merchant || '',
  }));
  const { metrics } = mapTransactions(records);

  // 3) Clear the old flow rows first — a day that was pure transfers now has no
  //    spending row, so an upsert alone would leave its stale inflated value.
  await query(
    `DELETE FROM metrics WHERE source = 'monarch' AND domain = 'wealth' AND metric = ANY($1)`,
    [FLOW_METRICS]
  );
  const metricsWritten = await metricsStore.insertMetrics(metrics);

  return { transactions: records.length, metricsWritten };
}

module.exports = { recomputeWealthFlows };
