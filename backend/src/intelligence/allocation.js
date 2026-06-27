// Asset allocation & single-name concentration — pure functions over normalized
// Monarch accounts ([{ name, type, subtype, balance, isAsset }]). No I/O, so the
// classification and concentration math is fully unit-testable.

const CLASS_LABEL = {
  cash: 'cash',
  investments: 'stocks',
  retirement: 'retirement',
  real_estate: 'real estate',
  crypto: 'crypto',
  other: 'other',
};

/**
 * Map a Monarch account to a broad asset class from its type/subtype/name. Order
 * matters: more specific buckets (retirement, real estate, crypto) are tested
 * before the generic brokerage/cash catch-alls.
 */
function classifyAccount(acct) {
  const s = `${acct.type || ''} ${acct.subtype || ''} ${(acct.name || '').toLowerCase()}`;
  if (/real.?estate|property|\bhome\b|\bland\b|residence/.test(s)) return 'real_estate';
  if (/retirement|401|\bira\b|roth|pension|\bhsa\b|\b403b\b/.test(s)) return 'retirement';
  if (/crypto|coinbase|bitcoin|ethereum|wallet/.test(s)) return 'crypto';
  if (/deposit|checking|savings|\bcash\b|money.?market|\bbank\b/.test(s)) return 'cash';
  if (/brokerage|invest|stock|equit|securit|\bfund\b|mutual|etf/.test(s)) return 'investments';
  return 'other';
}

/** % split of asset balances across classes. Returns { total, slices:[{cls,label,value,pct}] } or null. */
function assetAllocation(accounts) {
  const assets = (accounts || []).filter((a) => a.isAsset && a.balance > 0);
  const total = assets.reduce((s, a) => s + a.balance, 0);
  if (total <= 0) return null;
  const byClass = {};
  for (const a of assets) {
    const cls = classifyAccount(a);
    byClass[cls] = (byClass[cls] || 0) + a.balance;
  }
  const slices = Object.entries(byClass)
    .map(([cls, value]) => ({ cls, label: CLASS_LABEL[cls], value, pct: value / total }))
    .sort((a, b) => b.value - a.value);
  return { total, slices };
}

/**
 * Largest single VOLATILE position as a share of net worth. Excludes cash and
 * real estate — a big home or cash balance isn't single-name risk; the concern is
 * a concentrated equity/private-stock/crypto position (e.g. a "Stripe" account of
 * pre-IPO stock). Returns the top such account { name, balance, pct, cls } or null.
 */
function topConcentration(accounts, netWorth) {
  if (!(netWorth > 0)) return null;
  const risky = (accounts || []).filter(
    (a) => a.isAsset && a.balance > 0 && !['cash', 'real_estate'].includes(classifyAccount(a))
  );
  if (!risky.length) return null;
  const largest = risky.reduce((m, a) => (a.balance > m.balance ? a : m));
  return { name: largest.name, balance: largest.balance, pct: largest.balance / netWorth, cls: classifyAccount(largest) };
}

// Broad diversified funds aren't single-NAME risk — a 31% position in an S&P 500
// index fund is concentration in US large-cap, not in one company. These still
// show in the holdings list, but are excluded from the single-name concentration
// flag. Detect by security type, classic 5-char mutual-fund tickers (…X), or a
// small set of common ETFs.
const KNOWN_ETFS = new Set([
  'VTI', 'VOO', 'SPY', 'QQQ', 'VEA', 'VWO', 'BND', 'VXUS', 'SCHB', 'ITOT', 'IVV',
  'VUG', 'VTV', 'VIG', 'SCHD', 'VYM', 'VT', 'AGG', 'VNQ', 'VGT', 'VEU', 'DIA', 'IWM',
]);
function isFundLike(ticker, securityType) {
  const st = String(securityType || '').toLowerCase();
  if (/etf|mutual|index|fund/.test(st)) return true;
  const t = String(ticker || '').toUpperCase();
  if (/^[A-Z]{4}X$/.test(t)) return true; // 5-char mutual fund ending in X (FXAIX, VTSAX)
  return KNOWN_ETFS.has(t);
}

/**
 * Flatten brokerage holdings (individual tickers) + manually-tracked single-asset
 * accounts (e.g. a private "Stripe" pre-IPO stake, an "other" alt) into positions,
 * largest first. A SYNCED diversified brokerage account is NOT a position — its
 * individual holdings are. A MANUAL investment account has no synced ticker
 * breakdown, so it IS a single position. Each position carries `single` (is it
 * single-COMPANY risk, vs a diversified fund) for the concentration flag.
 * `holdings` is getInvestments() holdings (may be null); `accounts` is
 * getAccounts().accounts.
 */
function buildPositions(holdings, accounts) {
  const positions = [];
  let holdingsTotal = 0;
  for (const h of holdings || []) {
    if (!h || !(h.value > 0)) continue;
    if (String(h.securityType || '').toLowerCase() === 'cash') continue; // sweep cash isn't a name
    positions.push({
      name: h.ticker || h.name || 'Holding',
      value: h.value,
      kind: 'holding',
      single: !isFundLike(h.ticker, h.securityType),
    });
    holdingsTotal += h.value;
  }

  // Investment-class accounts: synced ones are already represented by the holdings
  // above; a manually-tracked one is a genuine single position. Trust the account's
  // manual flag when present, else infer from holdings coverage (largest synced
  // accounts soak up the holdings total; whatever's left over is manual).
  const inv = (accounts || [])
    .filter((a) => a.isAsset && a.balance > 0 && classifyAccount(a) === 'investments')
    .sort((x, y) => y.balance - x.balance);
  let remaining = holdingsTotal;
  for (const a of inv) {
    let manual = a.isManual;
    if (manual == null) {
      if (remaining >= 0.5 * a.balance) { remaining = Math.max(0, remaining - a.balance); manual = false; }
      else manual = true;
    } else if (!manual) {
      remaining = Math.max(0, remaining - a.balance);
    }
    if (manual) positions.push({ name: a.name, value: a.balance, kind: 'private', single: true });
  }

  // 'other'/alt single-asset accounts never have a ticker breakdown.
  for (const a of accounts || []) {
    if (a.isAsset && a.balance > 0 && classifyAccount(a) === 'other') {
      positions.push({ name: a.name, value: a.balance, kind: 'private', single: true });
    }
  }

  return positions.sort((x, y) => y.value - x.value);
}

const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
const pctStr = (x) => Math.round(x * 100) + '%';

/**
 * Build the allocation + concentration insight objects (same shape as the other
 * wealth insights: { type, tone, title, detail, evidence }). Pure: takes the
 * normalized accounts payload and the concentration threshold. Returns [] when
 * there isn't enough to say something useful.
 */
function buildAllocationInsights(accountsData, { concentrationPct = 0.15 } = {}) {
  if (!accountsData || !Array.isArray(accountsData.accounts) || !accountsData.accounts.length) return [];
  const { accounts } = accountsData;
  const netWorth = accountsData.netWorth
    ?? accounts.filter((a) => a.isAsset).reduce((s, a) => s + a.balance, 0)
       - accounts.filter((a) => !a.isAsset).reduce((s, a) => s + Math.abs(a.balance), 0);

  const out = [];

  // 1) Asset allocation — the stocks/cash/real-estate/etc. mix.
  const alloc = assetAllocation(accounts);
  if (alloc && alloc.slices.length >= 2) {
    const top = alloc.slices.slice(0, 5);
    const mix = top.map((s) => `${pctStr(s.pct)} ${s.label}`).join(' · ');
    const cash = alloc.slices.find((s) => s.cls === 'cash');
    const cashNote = !cash
      ? ' No cash bucket detected — keep some liquid for an emergency buffer.'
      : cash.pct < 0.03
        ? ` Cash is only ${pctStr(cash.pct)} of assets — thin for an emergency buffer.`
        : '';
    out.push({
      type: 'allocation',
      tone: 'neutral',
      title: `Asset mix: ${mix}`,
      detail:
        `Across ${fmt(alloc.total)} of assets: ${top.map((s) => `${s.label} ${fmt(s.value)} (${pctStr(s.pct)})`).join(', ')}.` +
        cashNote,
      evidence: { kind: 'allocation', total: Math.round(alloc.total), slices: alloc.slices.map((s) => ({ cls: s.cls, value: Math.round(s.value), pct: Math.round(s.pct * 100) })) },
    });
  }

  // 2) Single-name concentration — flag when one volatile position dominates.
  const conc = topConcentration(accounts, netWorth);
  if (conc && conc.pct >= concentrationPct) {
    const illiquid = conc.cls === 'other'; // private stock / RSUs / alt assets land in 'other'
    out.push({
      type: 'concentration',
      tone: 'watch',
      title: `Concentrated: ${conc.name} is ${pctStr(conc.pct)} of net worth`,
      detail:
        `${conc.name} (${fmt(conc.balance)}) is ${pctStr(conc.pct)} of your ${fmt(netWorth)} net worth — a large single position, so your wealth moves with it. ` +
        (illiquid
          ? `If that's a single company or private/pre-IPO stock, it's also illiquid: you can't easily rebalance or spend it, and a down round or failed exit hits hard. Worth a written plan for if/when you can diversify (e.g. at a liquidity event).`
          : `Worth a plan to diversify over time so one position doesn't dictate your net worth.`),
      evidence: { kind: 'concentration', name: conc.name, balance: Math.round(conc.balance), pct: Math.round(conc.pct * 100), cls: conc.cls },
    });
  }

  return out;
}

/**
 * Structured allocation view for the dedicated Asset Mix card (visual bar + a
 * concentration callout). Returns { total, netWorth, slices:[{cls,label,value,
 * pct}], concentration } with pct as a 0–1 fraction, or null if no accounts.
 */
function computeAllocationView(accountsData, { holdings = null, concentrationPct = 0.15, maxPositions = 8 } = {}) {
  if (!accountsData || !Array.isArray(accountsData.accounts) || !accountsData.accounts.length) return null;
  const alloc = assetAllocation(accountsData.accounts);
  if (!alloc) return null;
  const netWorth = accountsData.netWorth != null ? accountsData.netWorth : alloc.total;

  // True single-name positions: brokerage tickers (from getInvestments) + private
  // single-asset accounts. A diversified brokerage account is NOT a position.
  const positions = buildPositions(holdings, accountsData.accounts);
  const posTotal = positions.reduce((s, p) => s + p.value, 0);
  const topPositions = positions.slice(0, maxPositions).map((p) => ({
    name: p.name,
    value: Math.round(p.value),
    kind: p.kind,
    pctNw: netWorth > 0 ? p.value / netWorth : null,
    pctPort: posTotal > 0 ? p.value / posTotal : null,
  }));

  // Concentration = the largest single-COMPANY position as a share of net worth —
  // an individual stock or a private position. Diversified funds/ETFs (single=false)
  // are NOT single-name risk (a big S&P 500 index position is fine), and a whole
  // brokerage account is never a position.
  const top = positions.filter((p) => p.single).sort((a, b) => b.value - a.value)[0] || null;
  const concentration =
    top && netWorth > 0 && top.value / netWorth >= concentrationPct
      ? { name: top.name, balance: Math.round(top.value), pct: top.value / netWorth, kind: top.kind, illiquid: top.kind === 'private' }
      : null;

  return {
    total: Math.round(alloc.total),
    netWorth: netWorth != null ? Math.round(netWorth) : null,
    slices: alloc.slices.map((s) => ({ cls: s.cls, label: s.label, value: Math.round(s.value), pct: s.pct })),
    positions: topPositions,
    positionsTotal: Math.round(posTotal),
    concentration,
  };
}

module.exports = { classifyAccount, assetAllocation, topConcentration, buildPositions, buildAllocationInsights, computeAllocationView };
