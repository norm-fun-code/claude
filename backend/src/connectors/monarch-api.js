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

    // Once-per-day guard. Monarch is a LIVE GraphQL scrape, and runIngest() fires
    // on every full briefing rebuild — so without this, each intraday rebuild
    // re-scrapes your finances (wasteful, and Monarch 429-throttles datacenter
    // IPs). Skip if we already synced earlier TODAY in the user's timezone.
    // runConnector bumps last_sync_at even on this skip path, but a CALENDAR-DAY
    // comparison is stable under that: it stays "today" until midnight, then the
    // first run of the new day (e.g. the morning routine) scrapes fresh. A `full`
    // run (ctx.lastSyncAt === null, e.g. monarch-sync.js) always proceeds.
    if (ctx.lastSyncAt) {
      const tz = process.env.TZ || 'America/New_York';
      const localDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
      if (localDay(ctx.lastSyncAt) === localDay(new Date())) {
        return { metrics: [], documents: [] }; // already pulled today — don't scrape again
      }
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

    // Incremental window: 35-day lookback from last sync, 45 on the first run.
    // The window is wide enough to RE-PULL recently recategorized transactions
    // (people often fix a category a couple weeks late in Monarch), so the
    // correction reaches our stored docs and the post-sync flow recompute picks
    // it up. Override with MONARCH_LOOKBACK_DAYS.
    const lookbackDays = Number(process.env.MONARCH_LOOKBACK_DAYS) || 35;
    const since = ctx.lastSyncAt
      ? new Date(new Date(ctx.lastSyncAt).getTime() - lookbackDays * DAY)
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
        // Make 429s diagnosable: a login-stage 429 means we fell back to logging
        // in from Railway's datacenter IP (MONARCH_TOKEN missing/blank). A
        // fetch-stage 429 means the token works but Monarch is throttling reads.
        if (err.response?.status === 429) {
          const stage = err.monarchStage === 'login'
            ? 'login (no MONARCH_TOKEN set — fell back to datacenter login, which Monarch blocks)'
            : 'data fetch (token accepted but Monarch is rate-limiting reads — retry later)';
          err.message = `Monarch 429 at ${stage}`;
        }
        throw err;
      }
    }

    // Transactions -> daily spending/income/cashflow + per-transaction documents.
    // Carry Monarch's stable id so edits/moves update the same document.
    const txnRecords = data.txns.map((t) => ({
      Id: t.id,
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

    // Reconcile the fetched window against Monarch's current truth: after the
    // fresh docs are upserted, the runner prunes any stored transaction in
    // [startDate, endDate] that Monarch no longer reports there — i.e. one that
    // was deleted or MOVED to a different month. Without this, moving an expense
    // to a later month would leave its old-dated copy still counted in the
    // original month.
    const keepExternalIds = data.txns.map((t) => `monarch:${t.id}`);
    const reconcile = { source: 'monarch', domain: 'wealth', from: startDate, to: endDate, keepExternalIds };

    return { metrics, documents: txnMapped.documents, config, reconcile };
  },
};
