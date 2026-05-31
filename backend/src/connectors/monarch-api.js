// Monarch auto-sync connector: pulls transactions + balances straight from
// Monarch's API on each ingest (daily via the 7am routine). Incremental — only
// the last ~2 weeks of transactions plus today's balances — and reuses the CSV
// importer's mapping (source 'monarch'), so it's idempotent with manual uploads
// and honors MONARCH_EXCLUDE_ACCOUNTS. Dormant unless MONARCH_EMAIL/PASSWORD set.
const { login, getAccounts, getTransactions } = require('../services/monarch-api');
const { mapTransactions, mapBalances, dedupeMetrics } = require('./monarch');
const { registerSource } = require('../store/sources');

const DAY = 24 * 60 * 60 * 1000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

module.exports = {
  id: 'monarch_api',
  domain: 'wealth',
  displayName: 'Monarch (auto-sync)',

  async sync(ctx = {}) {
    if (!process.env.MONARCH_EMAIL || !process.env.MONARCH_PASSWORD) {
      return { metrics: [], documents: [] }; // not configured — stay dormant
    }
    // Metrics/docs are written under source 'monarch' (shared with CSV imports),
    // so make sure that source row exists for the FK.
    await registerSource({ id: 'monarch', domain: 'wealth', displayName: 'Monarch (CSV import)' });

    const token = await login();

    // Incremental window: 14-day lookback from last sync (late-posting txns),
    // 45 days on the very first API run.
    const since = ctx.lastSyncAt
      ? new Date(new Date(ctx.lastSyncAt).getTime() - 14 * DAY)
      : new Date(Date.now() - 45 * DAY);
    const startDate = ymd(since);
    const endDate = ymd(new Date());

    // Transactions -> daily spending/income/cashflow + per-transaction documents.
    const txns = await getTransactions(token, { startDate, endDate });
    const txnRecords = txns.map((t) => ({
      Date: t.date,
      Amount: t.amount,
      Merchant: t.merchant?.name || t.notes || 'Transaction',
      Category: t.category?.name || '',
      Account: t.account?.displayName || '',
    }));
    const txnMapped = mapTransactions(txnRecords);

    // Accounts -> today's net worth (sum of current balances; exclusions applied
    // inside mapBalances). One snapshot point per day, appended to history.
    const accounts = await getAccounts(token);
    const today = ymd(new Date());
    const balRecords = accounts.map((a) => ({
      Date: today,
      Account: a.displayName,
      Balance: a.currentBalance,
    }));
    const balMapped = mapBalances(balRecords);

    const metrics = dedupeMetrics([...txnMapped.metrics, ...balMapped.metrics]);
    return { metrics, documents: txnMapped.documents };
  },
};
