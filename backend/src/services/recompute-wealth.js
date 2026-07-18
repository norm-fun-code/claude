// One-time maintenance: rebuild the daily wealth FLOW metrics (spending,
// spending_discretionary, income, net_cashflow) from the stored Monarch
// transaction documents, applying the CURRENT mapTransactions rules — which now
// exclude internal transfers and credit-card payments.
//
// Why this is needed: the Monarch sync hashes each CSV and skips unchanged
// files, so simply re-syncing won't rewrite historical metric rows that were
// computed under the old (transfer-inflated) logic. The transaction documents,
// however, persist every transaction, so we can faithfully recompute from them.
const { query, withTransaction } = require('../db');
const metricsStore = require('../store/metrics');
const { mapTransactions } = require('../connectors/monarch');

const FLOW_METRICS = ['spending', 'spending_discretionary', 'income', 'net_cashflow'];

/**
 * opts.sinceDate (YYYY-MM-DD, optional): scope both the document read and the
 * metric delete to occurred_at/ts >= sinceDate. An unbounded read against a
 * long-lived `documents` table can hit the DB's statement timeout — bound it
 * to a recent window when only recent drift needs correcting. The delete MUST
 * use the same bound as the read: deleting a wider range than what gets
 * rebuilt would wipe older days' metrics with nothing to replace them.
 */
async function recomputeWealthFlows(opts = {}) {
  const { sinceDate } = opts;
  // 1) Pull stored Monarch transactions (documents preserve full history).
  const { rows } = await query(
    sinceDate
      ? `SELECT occurred_at, metadata
           FROM documents
          WHERE source = 'monarch' AND domain = 'wealth' AND metadata ? 'amount'
            AND occurred_at >= $1::date`
      : `SELECT occurred_at, metadata
           FROM documents
          WHERE source = 'monarch' AND domain = 'wealth' AND metadata ? 'amount'`,
    sinceDate ? [sinceDate] : []
  );

  // 2) Reconstruct records mapTransactions understands (field() matches on
  //    normalized header names, so these canonical keys resolve cleanly).
  // Safety: never wipe flow metrics off the back of an empty/failed read — if
  // there are no transaction documents, leave existing metrics untouched.
  if (rows.length === 0) return { transactions: 0, metricsWritten: 0, skipped: 'no transactions' };

  // LOCAL calendar day, not UTC — see localToday in monarch-mcp-sync.js.
  const tz = process.env.TZ || 'America/New_York';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const seen = new Set();
  const records = [];
  for (const r of rows) {
    const date = (r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at)).slice(0, 10);
    if (date > today) continue; // skip future-dated documents
    // Deduplicate by (date, amount, category, merchant, account) — prevents
    // CSV-imported and MCP-synced docs for the same transaction from doubling metrics.
    const key = `${date}|${r.metadata.amount}|${r.metadata.category || ''}|${r.metadata.merchant || ''}|${r.metadata.account || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      date,
      amount: r.metadata.amount,
      category: r.metadata.category || '',
      account: r.metadata.account || '',
      merchant: r.metadata.merchant || '',
    });
  }
  const { metrics } = mapTransactions(records);

  // 3) Clear the old flow rows first — a day that was pure transfers now has no
  //    spending row, so an upsert alone would leave its stale inflated value.
  //    Delete + re-insert run in ONE transaction so a concurrent read can never
  //    observe a window with the flow metrics momentarily missing.
  const metricsWritten = await withTransaction(async (client) => {
    const run = (text, params) => client.query(text, params);
    await run(
      sinceDate
        ? `DELETE FROM metrics WHERE source = 'monarch' AND domain = 'wealth' AND metric = ANY($1) AND ts >= $2::date`
        : `DELETE FROM metrics WHERE source = 'monarch' AND domain = 'wealth' AND metric = ANY($1)`,
      sinceDate ? [FLOW_METRICS, sinceDate] : [FLOW_METRICS]
    );
    return metricsStore.insertMetrics(metrics, run);
  });

  // New transaction-derived flow metrics landed → the canonical wealth totals
  // (spendingMtd) changed. Invalidate through the ONE bus (TRANSACTION_SYNC),
  // strictly after the transaction above committed. Durable and awaited (not
  // fire-and-forget): both callers (the admin resync route, the briefing
  // rebuild path) await this function and act on wealth state immediately
  // after, so a request that hits a different instance right after must not
  // observe stale wealth (Transactional Brain Invalidation, audit
  // recommendation #2, item 5).
  if (metricsWritten > 0) {
    try { await require('../brain/invalidation').bumpDurable('transaction_sync'); } catch { /* bus not loaded */ }
  }

  return { transactions: records.length, metricsWritten };
}

module.exports = { recomputeWealthFlows };
