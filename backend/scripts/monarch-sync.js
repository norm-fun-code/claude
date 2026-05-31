#!/usr/bin/env node
// Mac-side Monarch sync. Monarch rate-limits datacenter IPs (Railway gets 429),
// so this runs on your Mac (residential IP), pulls transactions + balances, and
// POSTs them as CSV to the backend's /api/import/monarch endpoint — reusing the
// same mapping, dedup, and MONARCH_EXCLUDE_ACCOUNTS filtering as manual imports.
//
// Usage:
//   MONARCH_TOKEN=... NORMOS_API_TOKEN=... NORMOS_URL=https://... \
//     node scripts/monarch-sync.js [--days 30]
//
// Schedule it daily with launchd (see scripts/com.normos.monarch-sync.plist).
const { getAccounts, getTransactions } = require('../src/services/monarch-api');

const URL = process.env.NORMOS_URL || 'https://backend-production-0902.up.railway.app';
const API_TOKEN = process.env.NORMOS_API_TOKEN || '';
const DAYS = (() => {
  const i = process.argv.indexOf('--days');
  return i >= 0 ? parseInt(process.argv[i + 1], 10) || 30 : 30;
})();

const ymd = (d) => new Date(d).toISOString().slice(0, 10);

// Minimal CSV: quote fields, escape embedded quotes. Good enough for our headers.
function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.join(',');
  const body = rows.map((r) => columns.map((c) => esc(r[c])).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

async function post(csv, label) {
  const res = await fetch(`${URL}/api/import/monarch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/csv',
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    },
    body: csv,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${label} import failed (${res.status}): ${JSON.stringify(json)}`);
  console.log(`${label}: ${JSON.stringify(json)}`);
}

async function main() {
  const token = process.env.MONARCH_TOKEN;
  if (!token) throw new Error('MONARCH_TOKEN not set');

  const startDate = ymd(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const endDate = ymd(Date.now());
  const today = endDate;

  // Transactions -> CSV (Date, Merchant, Category, Account, Amount).
  const txns = await getTransactions(token, { startDate, endDate });
  const txnRows = txns.map((t) => ({
    Date: t.date,
    Merchant: t.merchant?.name || t.notes || 'Transaction',
    Category: t.category?.name || '',
    Account: t.account?.displayName || '',
    Amount: t.amount,
  }));
  console.log(`Fetched ${txnRows.length} transactions (${startDate} → ${endDate}).`);
  if (txnRows.length) {
    await post(toCsv(txnRows, ['Date', 'Merchant', 'Category', 'Account', 'Amount']), 'transactions');
  }

  // Accounts -> balances CSV (Date, Account, Balance) — one snapshot for today.
  const accounts = await getAccounts(token);
  const balRows = accounts.map((a) => ({
    Date: today,
    Account: a.displayName,
    Balance: a.currentBalance,
  }));
  console.log(`Fetched ${balRows.length} account balances.`);
  if (balRows.length) {
    await post(toCsv(balRows, ['Date', 'Account', 'Balance']), 'balances');
  }

  console.log('Monarch sync complete.');
}

main().catch((err) => {
  console.error('Monarch sync failed:', err.message);
  process.exit(1);
});
