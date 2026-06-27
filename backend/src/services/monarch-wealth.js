// Monarch wealth service — normalized, authoritative wealth data pulled from
// Monarch's official MCP server via direct JSON-RPC (no LLM). Powers the
// subscription audit, budget pacing, and investment views. Dormant (returns
// null) unless Monarch MCP is configured.
const rpc = require('./monarch-mcp-rpc');
const monarchMcp = require('./monarch-mcp');

function isConfigured() {
  return monarchMcp.isConfigured();
}

// Billing cadence → times per year, for normalizing every recurring charge to a
// comparable monthly cost.
const FREQ_PER_YEAR = {
  daily: 365, weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12,
  bimonthly: 6, quarterly: 4, semiannual: 2, semiannually: 2,
  yearly: 1, annual: 1, annually: 1,
};

function normStream(s) {
  const perYear = FREQ_PER_YEAR[String(s.frequency || '').toLowerCase()] || 12;
  const amount = Math.abs(Number(s.amount) || 0);
  return {
    id: s.stream_id,
    name: s.name || 'Recurring',
    amount,
    monthly: amount * perYear / 12,
    annual: amount * perYear,
    frequency: s.frequency || 'monthly',
    perYear,
    nextDate: s.next_forecasted_date || null,
    lastDate: s.last_paid_date || null,
    account: s.account || null,
    category: s.category || null,
  };
}

/**
 * Normalized recurring activity from GetRecurring. Returns income / expense /
 * creditCard / transfer streams, each with a monthly-normalized cost, plus the
 * total monthly recurring expense load. null if MCP isn't configured.
 */
async function getRecurring() {
  if (!isConfigured()) return null;
  const r = await rpc.callToolJson('GetRecurring', { include_liabilities: true });
  const pick = (k) => (r?.[k]?.recurring_transaction_streams || []).map(normStream);
  const expenses = pick('recurring_expense_streams').sort((a, b) => b.monthly - a.monthly);
  const totalMonthly = expenses.reduce((a, s) => a + s.monthly, 0);
  return {
    income: pick('recurring_income_streams').sort((a, b) => b.monthly - a.monthly),
    expenses,
    creditCards: pick('recurring_credit_card_streams'),
    transfers: pick('recurring_transfer_streams'),
    totalMonthlyExpense: totalMonthly,
    totalAnnualExpense: totalMonthly * 12,
  };
}

/**
 * Budget pacing for the current month from GetBudget(include_actuals). For each
 * expense category with a real budget, compares actual spend against where it
 * *should* be this far into the month (linear pacing). null if MCP not set up.
 */
async function getBudgetPacing({ now = new Date() } = {}) {
  if (!isConfigured()) return null;
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const monthStart = `${y}-${String(mo + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const monthEnd = `${y}-${String(mo + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const dayOfMonth = now.getUTCDate();
  const elapsed = Math.min(1, dayOfMonth / lastDay);

  const r = await rpc.callToolJson('GetBudget', { start_date: monthStart, end_date: monthEnd, include_actuals: true });
  const lines = [];
  for (const d of r?.data || []) {
    if (d.category_type !== 'expense') continue;           // skip income & transfers
    const budget = Math.abs(Number(d.budget_amount) || 0); // Monarch signs expenses negative
    if (budget <= 0) continue;                             // only real budgets
    const actual = Math.abs(Number(d.actual_amount) || 0); // same sign convention
    const expectedByNow = budget * elapsed;
    lines.push({
      category: d.category,
      group: d.category_group || null,
      budget,
      actual,
      remaining: budget - actual,
      // pace: >1 means spending faster than the month is elapsing
      pace: expectedByNow > 0 ? actual / expectedByNow : (actual > 0 ? Infinity : 0),
      overBudget: actual > budget + 0.01, // >1¢ over — avoids floating-point false positives
    });
  }
  lines.sort((a, b) => b.pace - a.pace);
  return {
    asOf: now.toISOString(),
    dayOfMonth,
    daysInMonth: lastDay,
    elapsed,
    lines,
    totals: r?.totals_overall || null,
  };
}

/**
 * Investment holdings + period performance from GetInvestments. Returns total
 * value, the period's dollar/percent change, biggest movers, and largest
 * holdings. null if MCP isn't configured.
 */
async function getInvestments({ start, end } = {}) {
  if (!isConfigured()) return null;
  const now = new Date();
  const e = end || now.toISOString().slice(0, 10);
  const s = start || new Date(now.getTime() - 7 * 864e5).toISOString().slice(0, 10);
  const r = await rpc.callToolJson('GetInvestments', { start_date: s, end_date: e });
  const holdings = (r?.investments || []).map((h) => ({
    ticker: h.ticker,
    name: h.name || h.security_name || h.securityName || h.ticker || null,
    value: Number(h.value) || 0,
    securityType: h.security_type || null,
    periodChange: Number(h.period_change_dollars) || 0,
    periodChangePct: Number(h.period_change_percent) || 0,
    allTimeChange: Number(h.variation_dollars) || 0,
    allTimePct: Number(h.variation_percent) || 0,
  }));
  const totalValue = holdings.reduce((a, h) => a + h.value, 0);
  // Period change excludes pure-cash positions (they don't "move").
  const periodChange = holdings.reduce((a, h) => a + h.periodChange, 0);
  const priorValue = totalValue - periodChange;
  const withMoves = holdings.filter((h) => h.securityType !== 'cash' && h.periodChange !== 0);
  const byMove = [...withMoves].sort((a, b) => b.periodChange - a.periodChange);
  return {
    asOf: e,
    periodStart: s,
    totalValue,
    periodChange,
    periodChangePct: priorValue > 0 ? (periodChange / priorValue) * 100 : 0,
    holdings: holdings.sort((a, b) => b.value - a.value),
    topGainers: byMove.slice(0, 3),
    topLosers: byMove.slice(-3).reverse(),
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize one GetAccounts row across Monarch's varying field shapes (the MCP
 * sometimes returns nested {type:{name}} objects, sometimes flat strings). Returns
 * { name, type, subtype, balance, isAsset } or null if unparseable.
 */
function normAccount(a) {
  if (!a || typeof a !== 'object') return null;
  const name = a.display_name || a.displayName || a.name || a.account_name || 'Account';
  const typeObj = a.type ?? a.account_type ?? '';
  const type = String(typeof typeObj === 'object' ? (typeObj.name || typeObj.type || '') : typeObj).toLowerCase();
  const subObj = a.subtype ?? '';
  const subtype = String(typeof subObj === 'object' ? (subObj.name || '') : subObj).toLowerCase();
  const balance = numOrNull(
    a.current_balance ?? a.displayBalance ?? a.currentBalance ?? a.balance ?? a.value
  );
  if (balance == null) return null;
  const isAsset = a.is_asset != null ? !!a.is_asset : (a.isAsset != null ? !!a.isAsset : balance >= 0);
  return { name, type, subtype, balance, isAsset };
}

/**
 * Per-account balances from GetAccounts — the basis for asset allocation and
 * single-name concentration. Returns { netWorth, totalAssets, totalLiabilities,
 * accounts: [{name,type,subtype,balance,isAsset}] } or null if MCP isn't
 * configured / returns nothing.
 */
async function getAccounts() {
  if (!isConfigured()) return null;
  const r = await rpc.callToolJson('GetAccounts', {});
  if (!r) return null;
  const raw = Array.isArray(r.accounts) ? r.accounts : (Array.isArray(r.data) ? r.data : []);
  const accounts = raw.map(normAccount).filter(Boolean);
  if (!accounts.length) return null;
  return {
    netWorth: numOrNull(r.total_balance),
    totalAssets: numOrNull(r.total_asset_balance),
    totalLiabilities: Math.abs(numOrNull(r.total_liabilities_balance) ?? 0),
    accounts,
  };
}

module.exports = { isConfigured, getRecurring, getBudgetPacing, getInvestments, getAccounts, normAccount };
