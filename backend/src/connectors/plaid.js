// Plaid connector (Wealth domain). Pulls account balances and transactions
// across one or more linked institutions.
//
// Setup is one-time per institution: obtain an access_token via Plaid Link, then
// add it to PLAID_ACCESS_TOKENS (comma-separated for multiple institutions).
//
// Emits clean snapshot metrics (net_worth, assets, liabilities, cash,
// investments at ts=now — idempotent and ideal for trends) and stores every
// transaction as a document (deduped by transaction_id). Spending analytics are
// derived from those transaction documents in the intelligence layer.
const axios = require('axios');

const ASSET_DEPOSITORY = 'depository';
const ASSET_INVESTMENT = new Set(['investment', 'brokerage']);
const LIABILITY_TYPES = new Set(['credit', 'loan']);

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function baseUrl() {
  const env = process.env.PLAID_ENV || 'sandbox';
  return `https://${env}.plaid.com`;
}

/** Pure: classify accounts into a net-worth breakdown (assumes a single currency). */
function computeBalances(accounts) {
  let cash = 0;
  let investments = 0;
  let liabilities = 0;

  for (const a of accounts || []) {
    const bal = Number(a.balances?.current ?? 0);
    if (!Number.isFinite(bal)) continue;
    if (a.type === ASSET_DEPOSITORY) cash += bal;
    else if (ASSET_INVESTMENT.has(a.type)) investments += bal;
    else if (LIABILITY_TYPES.has(a.type)) liabilities += bal;
  }

  const assets = cash + investments;
  return {
    netWorth: round2(assets - liabilities),
    assets: round2(assets),
    liabilities: round2(liabilities),
    cash: round2(cash),
    investments: round2(investments),
  };
}

/** Pure: Plaid transactions -> knowledge documents. */
function mapTransactions(transactions) {
  return (transactions || [])
    .filter((t) => t && t.transaction_id)
    .map((t) => {
      const category = t.personal_finance_category?.primary || (t.category || []).join(' > ') || null;
      return {
        source: 'plaid',
        domain: 'wealth',
        externalId: t.transaction_id,
        title: t.merchant_name || t.name || 'Transaction',
        url: null,
        content: [t.name, t.merchant_name, `$${t.amount}`, category]
          .filter(Boolean)
          .join(' — '),
        occurredAt: t.authorized_date || t.date || null,
        metadata: {
          amount: t.amount,
          currency: t.iso_currency_code,
          category,
          accountId: t.account_id,
          pending: t.pending,
        },
      };
    });
}

async function plaidPost(path, body) {
  const { data } = await axios.post(`${baseUrl()}${path}`, {
    client_id: process.env.PLAID_CLIENT_ID,
    secret: process.env.PLAID_SECRET,
    ...body,
  });
  return data;
}

module.exports = {
  id: 'plaid',
  domain: 'wealth',
  displayName: 'Plaid',

  async sync(ctx = {}) {
    if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
      throw new Error('PLAID_CLIENT_ID / PLAID_SECRET not set');
    }
    const tokens = (process.env.PLAID_ACCESS_TOKENS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (tokens.length === 0) throw new Error('PLAID_ACCESS_TOKENS not set');

    const now = new Date();
    const cursors = { ...(ctx.config?.cursors || {}) };
    let allAccounts = [];
    const documents = [];

    for (let i = 0; i < tokens.length; i++) {
      const access_token = tokens[i];
      const key = `t${i}`;

      const balResp = await plaidPost('/accounts/balance/get', { access_token });
      allAccounts = allAccounts.concat(balResp.accounts || []);

      // Incremental transaction sync — paginate until caught up.
      let cursor = cursors[key] || undefined;
      let hasMore = true;
      while (hasMore) {
        const txResp = await plaidPost('/transactions/sync', { access_token, cursor });
        documents.push(...mapTransactions(txResp.added || []));
        documents.push(...mapTransactions(txResp.modified || []));
        cursor = txResp.next_cursor;
        hasMore = Boolean(txResp.has_more);
      }
      cursors[key] = cursor;
    }

    const b = computeBalances(allAccounts);
    const m = (metric, value) => ({ ts: now, domain: 'wealth', metric, value, unit: 'usd', source: 'plaid' });
    const metrics = [
      m('net_worth', b.netWorth),
      m('assets', b.assets),
      m('liabilities', b.liabilities),
      m('cash', b.cash),
      m('investments', b.investments),
    ];

    return { metrics, documents, config: { cursors } };
  },

  // exported for unit testing
  computeBalances,
  mapTransactions,
};
