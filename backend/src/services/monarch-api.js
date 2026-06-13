// Monarch Money API client (unofficial — the same GraphQL API their web app
// uses). Email+password login (no MFA), then pull transactions + account
// balances. Best-effort; callers handle failures gracefully.
const axios = require('axios');
const crypto = require('crypto');

const BASE = 'https://api.monarch.com';

function headers(token, deviceUuid) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://app.monarchmoney.com',
    'Client-Platform': 'web',
    'x-cio-client-platform': 'web',
    'x-cio-site-id': '2598be4aa410159198b2',
    'device-uuid': deviceUuid || process.env.MONARCH_DEVICE_UUID || crypto.randomUUID(),
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
  };
  if (token) h.Authorization = `Token ${token}`;
  return h;
}

async function login() {
  const username = process.env.MONARCH_EMAIL;
  const password = process.env.MONARCH_PASSWORD;
  if (!username || !password) throw new Error('MONARCH_EMAIL/MONARCH_PASSWORD not set');
  const deviceUuid = process.env.MONARCH_DEVICE_UUID || crypto.randomUUID();
  let data;
  try {
    ({ data } = await axios.post(
      `${BASE}/auth/login/`,
      { username, password, trusted_device: true, supports_mfa: true, supports_email_otp: true },
      { headers: headers(null, deviceUuid), timeout: 15000 }
    ));
  } catch (err) {
    // Tag so the connector can tell login-time 429s (datacenter IP blocked)
    // apart from GraphQL-time ones (valid token but throttled).
    err.monarchStage = 'login';
    throw err;
  }
  if (!data || !data.token) throw new Error('Monarch login returned no token');
  return data.token;
}

async function gql(token, query, variables = {}) {
  const { data } = await axios.post(
    `${BASE}/graphql`,
    { query, variables },
    { headers: headers(token), timeout: 25000 }
  );
  if (data.errors) {
    throw new Error('Monarch GraphQL error: ' + JSON.stringify(data.errors).slice(0, 300));
  }
  return data.data;
}

async function getAccounts(token) {
  const query = `query NormOS_Accounts {
    accounts {
      id
      displayName
      currentBalance
    }
  }`;
  const d = await gql(token, query);
  return d.accounts || [];
}

async function getTransactions(token, { startDate, endDate }) {
  const query = `query NormOS_Transactions($offset: Int, $limit: Int, $filters: TransactionFilterInput) {
    allTransactions(filters: $filters) {
      results(offset: $offset, limit: $limit) {
        id
        date
        amount
        merchant { name }
        category { name }
        account { displayName }
        notes
      }
    }
  }`;
  const out = [];
  let offset = 0;
  for (let i = 0; i < 100; i++) { // up to 10k transactions — covers 3+ years for most users
    const d = await gql(token, query, { offset, limit: 100, filters: { startDate, endDate } });
    const results = d.allTransactions?.results || [];
    out.push(...results);
    if (results.length < 100) break;
    offset += 100;
  }
  return out;
}

// Monthly budget targets per category. Monarch's budgetData keys amounts by
// category id, so we join with getCategories() to get human names. Returns
// [{ category, budget }] for the requested month (YYYY-MM-01 .. end of month).
async function getBudgets(token, { startDate, endDate }) {
  const query = `query NormOS_Budgets($startDate: Date!, $endDate: Date!) {
    budgetData(startMonth: $startDate, endMonth: $endDate) {
      monthlyAmountsByCategory {
        category { id }
        monthlyAmounts { month plannedCashFlowAmount actualAmount }
      }
    }
  }`;
  const d = await gql(token, query, { startDate, endDate });
  const byCat = d.budgetData?.monthlyAmountsByCategory || [];
  const cats = await getCategories(token);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const out = [];
  for (const row of byCat) {
    const id = row.category?.id;
    const cat = byId.get(id);
    // Only expense categories — income/transfer budgets (Paychecks, etc.) aren't
    // "overspending" and would be misleading in a spending-vs-budget list.
    if (!cat || (cat.group?.type && cat.group.type !== 'expense')) continue;
    const m = (row.monthlyAmounts || [])[0] || {};
    const budget = Math.abs(Number(m.plannedCashFlowAmount) || 0);
    if (!id || !budget) continue;
    out.push({ category: cat.name || id, budget, actual: Math.abs(Number(m.actualAmount) || 0) });
  }
  return out;
}

async function getCategories(token) {
  const query = `query NormOS_Categories {
    categories { id name group { type } }
  }`;
  const d = await gql(token, query);
  return d.categories || [];
}

module.exports = { login, getAccounts, getTransactions, getBudgets, getCategories };
