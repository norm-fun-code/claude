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
    const hasToken = process.env.MONARCH_TOKEN || ctx.config?.monarchToken;
    const hasLogin = process.env.MONARCH_EMAIL && process.env.MONARCH_PASSWORD;
    if (!hasToken && !hasLogin) {
      return { metrics: [], documents: [] }; // not configured — stay dormant
    }
    // Metrics/docs are written under source 'monarch' (shared with CSV imports),
    // so make sure that source row exists for the FK.
    await registerSource({ id: 'monarch', domain: 'wealth', displayName: 'Monarch (CSV import)' });

    // Prefer a pre-minted token (env, then cached) to avoid logging in on the
    // server — Monarch rate-limits login from datacenter IPs (429).
    let token = process.env.MONARCH_TOKEN || ctx.config?.monarchToken || null;
    let mintedToken = null;
    if (!token) {
      token = await login();
      mintedToken = token;
    }

    const fetchAll = async (tok) => {
      const txns = await getTransactions(tok, { startDate, endDate });
      const accounts = await getAccounts(tok);
      return { txns, accounts };
    };

    // Incremental window: 14-day lookback from last sync (late-posting txns),
    // 45 days on the very first API run.
    const since = ctx.lastSyncAt
      ? new Date(new Date(ctx.lastSyncAt).getTime() - 14 * DAY)
      : new Date(Date.now() - 45 * DAY);
    const startDate = ymd(since);
    const endDate = ymd(new Date());

    let data;
    try {
      data = await fetchAll(token);
    } catch (err) {
      // Token expired/invalid — re-login once (only if we have credentials and
      // weren't handed a fixed env token).
      if (err.response?.status === 401 && hasLogin && !process.env.MONARCH_TOKEN) {
        token = await login();
        mintedToken = token;
        data = await fetchAll(token);
      } else {
        throw err;
      }
    }

    // Transactions -> daily spending/income/cashflow + per-transaction documents.
    const txnRecords = data.txns.map((t) => ({
      Date: t.date,
      Amount: t.amount,
      Merchant: t.merchant?.name || t.notes || 'Transaction',
      Category: t.category?.name || '',
      Account: t.account?.displayName || '',
    }));
    const txnMapped = mapTransactions(txnRecords);

    // Accounts -> today's net worth (sum of current balances; exclusions applied
    // inside mapBalances). One snapshot point per day, appended to history.
    const today = ymd(new Date());
    const balRecords = data.accounts.map((a) => ({
      Date: today,
      Account: a.displayName,
      Balance: a.currentBalance,
    }));
    const balMapped = mapBalances(balRecords);

    const metrics = dedupeMetrics([...txnMapped.metrics, ...balMapped.metrics]);
    const config = mintedToken ? { ...(ctx.config || {}), monarchToken: mintedToken } : undefined;
    return { metrics, documents: txnMapped.documents, config };
  },
};
