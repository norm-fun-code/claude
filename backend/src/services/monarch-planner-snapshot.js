// Account-level bridge for the planner, independent of the retired MCP.
// Do not apply NormOS exclusions here: the planner has its own retirement policy.
function makeSnapshot(accounts, { asOf = new Date().toISOString(), source = 'normos-api', allowMissing = false } = {}) {
  if (!Array.isArray(accounts) || !accounts.length || !Number.isFinite(Date.parse(asOf))) return null;
  const ids = new Set();
  const clean = [];
  const missingAccounts = [];
  for (const account of accounts) {
    const name = account.displayName || account.name;
    const raw = account.currentBalance;
    const balance = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.replace(/[$,]/g, '')) : NaN;
    const id = String(account.id || name || '');
    if (!name || ids.has(id)) return null;
    ids.add(id);
    if (allowMissing && (raw == null || raw === '')) { missingAccounts.push({id, name}); continue; }
    if (!Number.isFinite(balance)) return null;
    clean.push({ id, displayName: name, currentBalance: balance });
  }
  if (!clean.length) return null;
  return { version: 1, accounts: clean, partial: missingAccounts.length > 0, missingAccounts, asOf: new Date(asOf).toISOString(), source };
}
function fromBalanceRecords(records) {
  const field = (r, names) => Object.entries(r).find(([k]) => names.includes(k.toLowerCase().replace(/[^a-z]/g, '')))?.[1];
  const dated = records.map(r => ({ r, date: Date.parse(field(r, ['date'])) })).filter(r => Number.isFinite(r.date));
  if (!dated.length) return null;
  const date = Math.max(...dated.map(r => r.date));
  return makeSnapshot(dated.filter(r => r.date === date).map(({ r }) => ({
    displayName: field(r, ['account', 'accountname']),
    currentBalance: field(r, ['balance', 'currentbalance', 'amount']),
  })), { asOf: new Date(date).toISOString(), source: 'normos-import' });
}
async function publishSnapshot(snapshot) {
  if (!snapshot) return;
  const { query } = require('../db');
  // Atomic timestamp guard: an older CSV must never replace a newer API pull.
  await query(`UPDATE sources SET config = config || jsonb_build_object('plannerAccounts', $1::jsonb)
    WHERE id = 'monarch' AND COALESCE(config->'plannerAccounts'->>'asOf', '') <= $2`,
  [JSON.stringify(snapshot), snapshot.asOf]);
}
module.exports = { makeSnapshot, fromBalanceRecords, publishSnapshot };
