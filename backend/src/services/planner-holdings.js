'use strict';
// Read-only positions. Price growth is not a contribution-adjusted portfolio return.
const HOLDINGS_QUERY = `query NormOS_Holdings($input: PortfolioInput) {
  portfolio(input: $input) {
    aggregateHoldings { edges { node {
      id quantity basis totalValue
      securityPriceChangeDollars securityPriceChangePercent
      security { id name ticker type typeDisplay }
      holdings { id name ticker type typeDisplay }
    } } }
  }
}`;
const TYPE_ALIASES = { cryptocurrency: 'crypto', mutualfund: 'mutual_fund', fixed_income: 'bond', fixedincome: 'bond' };
function normaliseType(t) {
  const k = String(t || 'other').toLowerCase().replace(/[\s-]+/g, '_');
  return TYPE_ALIASES[k] || TYPE_ALIASES[k.replace(/_/g, '')] || k;
}
const numOr0 = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') { const n = parseFloat(v.replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; }
  return 0;
};
const numOrNull = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const n = parseFloat(v.replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; }
  return null;
};
// Tolerant of where the edges land: this query shape is Monarch's undocumented web API, so
// accept the payload whether it arrives nested under data/portfolio or already unwrapped.
function extractHoldingEdges(payload) {
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node.edges)) return node.edges;
    for (const v of Object.values(node)) { const hit = walk(v, depth + 1); if (hit) return hit; }
    return null;
  };
  return walk(payload?.aggregateHoldings ?? payload, 0) || [];
}
function mapHoldings(payload) {
  const rows = extractHoldingEdges(payload).map(e => {
    const n = e?.node ?? e ?? {};
    const sec = n.security || (Array.isArray(n.holdings) ? n.holdings[0] : null) || {};
    const value = numOr0(n.totalValue ?? n.value);
    const basis = numOr0(n.basis);
    const allTimeChange = basis > 0 ? value - basis : 0;
    const priceChangePct = numOrNull(n.securityPriceChangePercent);
    const priceChangePerShare = numOrNull(n.securityPriceChangeDollars);
    const quantity = numOrNull(n.quantity);
    // securityPriceChangeDollars is the change in one security's price, not this
    // position's dollar change. Prefer the percentage applied to the current position;
    // fall back to price change × quantity when Monarch omits the percentage.
    const positionPriceChange = priceChangePct != null && priceChangePct > -100
      ? value - value / (1 + priceChangePct / 100)
      : (priceChangePerShare != null && quantity != null ? priceChangePerShare * quantity : null);
    return {
      ticker: sec.ticker || sec.name || '\u2014',
      name: sec.name || sec.ticker || '',
      value: Math.round(value),
      securityType: normaliseType(sec.type ?? sec.typeDisplay),
      periodChange: positionPriceChange == null ? null : Math.round(positionPriceChange * 100) / 100,
      periodChangePct: priceChangePct == null ? null : Math.round(priceChangePct * 100) / 100,
      allTimeChange: Math.round(allTimeChange * 100) / 100,
      allTimePct: basis > 0 ? Math.round(allTimeChange / basis * 10000) / 100 : 0,
    };
  }).filter(h => h.value !== 0);
  if (!rows.length) throw new Error('Monarch returned no holdings.');
  return rows.sort((a, b) => b.value - a.value);
}

function periodWindow(period, timestamp = Date.now()) {
  if (!['1W','1M','3M','YTD','1Y'].includes(period)) throw new Error('Choose 1W, 1M, 3M, YTD or 1Y.');
  const endDate = new Date(timestamp).toISOString().slice(0,10);
  const days = {'1W':7,'1M':30,'3M':90,'1Y':365};
  return { endDate, startDate: period === 'YTD' ? endDate.slice(0,4)+'-01-01' : new Date(timestamp-days[period]*86400000).toISOString().slice(0,10) };
}
function shapePortfolio(holdings, window) {
  const totalValue = holdings.reduce((s,h)=>s+h.value,0);
  const covered = holdings.filter(h=>h.securityType!=='cash');
  const complete = covered.length>0 && covered.every(h=>Number.isFinite(h.periodChange));
  const growth = complete ? covered.reduce((s,h)=>s+h.periodChange,0) : null;
  const allTimeChange = holdings.reduce((s,h)=>s+h.allTimeChange,0);
  const movers = covered.filter(h=>Number.isFinite(h.periodChange)).sort((a,b)=>b.periodChange-a.periodChange);
  return { periodStart:window.startDate, periodEnd:window.endDate, totalValue,
    periodMetric:'current_holdings_growth', periodChange:growth,
    periodChangePct:growth!==null && totalValue-growth>0 ? growth/(totalValue-growth)*100 : null,
    allTimeChange, allTimePct:totalValue-allTimeChange>0 ? allTimeChange/(totalValue-allTimeChange)*100 : null,
    holdings, topGainers:movers.filter(h=>h.periodChange>0).slice(0,5),
    topLosers:movers.filter(h=>h.periodChange<0).reverse().slice(0,5) };
}
module.exports={HOLDINGS_QUERY,mapHoldings,periodWindow,shapePortfolio};
