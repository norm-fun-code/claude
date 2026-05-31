// Monarch Money API client (unofficial — the same GraphQL API their web app
// uses). Email+password login (no MFA), then pull transactions + account
// balances. Best-effort; callers handle failures gracefully.
const axios = require('axios');
const crypto = require('crypto');

const BASE = 'https://api.monarchmoney.com';

function headers(token) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://app.monarchmoney.com',
    'Client-Platform': 'web',
    'device-uuid': process.env.MONARCH_DEVICE_UUID || crypto.randomUUID(),
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
  const { data } = await axios.post(
    `${BASE}/auth/login/`,
    { username, password, trusted_device: true, supports_mfa: true },
    { headers: headers(), timeout: 15000 }
  );
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
  for (let i = 0; i < 30; i++) {
    const d = await gql(token, query, { offset, limit: 100, filters: { startDate, endDate } });
    const results = d.allTransactions?.results || [];
    out.push(...results);
    if (results.length < 100) break;
    offset += 100;
  }
  return out;
}

module.exports = { login, getAccounts, getTransactions };
