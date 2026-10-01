'use strict';
// ═══ WHERE A YEAR'S INCOME GOES ═══
// One projected year, read as shares of income: how much goes to tax, how much is committed
// before anyone decides anything, how much is everyday, how much is choice, and what is left.
// Pure — it reads a row the projection already produced and invents no figure of its own, so
// every share can be checked against the same year in the Trajectory table.
//
// FIXED IS A JUDGEMENT, NOT A FACT. Which lines count as fixed is the one opinion in here, so
// it is written down once, shown to the reader, and tested rather than scattered through the
// page. The rule used: a cost is fixed if it keeps arriving whether or not the household
// changes how it lives this month — a lease, a school bill, an insurance premium. A grocery
// bill is not fixed (it flexes) but it is not optional either, so it sits between.

(function (root) {
  const TIERS = [
    // The same two groups the Budget uses, under the same names, so a figure means one thing on both
    // screens. Groceries and medical flex a little but cannot be skipped, so they sit with the fixed costs.
    { key: 'fixed', label: 'Fixed costs',
      note: 'Housing, childcare, tuition, insurance, utilities & phone, transit, auto, and the essentials: groceries and medical.' },
    { key: 'choice', label: 'Discretionary',
      note: 'Choices: dining, shopping, clothing, vacations, entertainment, charity, misc.' },
  ];
  const FIXED_LIVING = ['insurance', 'utilities', 'transit', 'auto'];
  const ESSENTIAL_LIVING = ['groceries', 'medical'];

  // A living line the engine adds later lands in discretionary rather than vanishing — the
  // alternative is a breakdown that stops adding up the day someone adds a category.
  const tierOfLiving = k => FIXED_LIVING.includes(k) || ESSENTIAL_LIVING.includes(k) ? 'fixed' : 'choice';

  const LIVING_LABEL = { groceries: 'Groceries', dining: 'Dining', shopping: 'Shopping', clothing: 'Clothing',
    vacations: 'Vacations', auto: 'Auto', insurance: 'Insurance', misc: 'Misc', entertainment: 'Entertainment',
    charity: 'Charity', medical: 'Medical', transit: 'Transit', utilities: 'Utilities & phone' };

  // basis 'gross': every dollar earned, so tax and pre-tax deductions are lines.
  // basis 'net'  : what reaches the household after them — the denominator spending is judged by.
  function compute(r, basis) {
    if (!r) return null;
    const spendBasis = basis === 'spend', net = basis === 'net';
    const gross = Number(r.gross) || 0, netTC = Number(r.netTC) || 0;
    const denom = spendBasis ? Math.round(Number(r.totEFull != null ? r.totEFull : r.totE) || 0) : net ? netTC : gross;
    if (!(denom > 0)) return null;

    const living = r.livFullParts || r.livParts || {};
    const lines = [
      { key: 'housing', label: 'Housing', tier: 'fixed', value: r.hFull != null ? r.hFull : r.h },
      { key: 'childcare', label: 'Childcare', tier: 'fixed', value: r.ccFull != null ? r.ccFull : r.cc },
      { key: 'tuition', label: 'Tuition', tier: 'fixed', value: r.tuFull != null ? r.tuFull : r.tu },
      ...Object.keys(living).map(k => ({ key: k, label: LIVING_LABEL[k] || k, tier: tierOfLiving(k), value: living[k] })),
    ].map(l => ({ ...l, value: Math.round(l.value || 0) }));
    // A one-off is neither fixed nor chosen, and it can be negative. Its own line, so a year
    // with a wedding in it does not make the fixed share look like it jumped.
    const oneOff = Math.round(r.eAdj || 0);

    const spend = lines.reduce((t, l) => t + l.value, 0) + oneOff;
    const tax = Math.round(r.tax || 0);
    const pretax = Math.round(gross - (r.tax || 0) - netTC);       // 401(k), benefits, practice costs
    const left = netTC - spend;                                    // negative = spending beyond income

    const tiers = TIERS.map(t => {
      const ls = lines.filter(l => l.tier === t.key && l.value !== 0).map(l => ({ ...l, share: l.value / denom }));
      const value = lines.filter(l => l.tier === t.key).reduce((s, l) => s + l.value, 0);
      return { ...t, value, share: value / denom, lines: ls };
    });

    const segments = [
      ...(net || spendBasis ? [] : [
        { key: 'tax', label: 'Taxes', value: tax },
        { key: 'pretax', label: '401(k), benefits & practice costs', value: pretax },
      ]),
      ...tiers.map(t => ({ key: t.key, label: t.label, value: t.value })),
      ...(oneOff ? [{ key: 'oneoff', label: 'One-off', value: oneOff }] : []),
      ...(spendBasis ? [] : [{ key: left >= 0 ? 'left' : 'short', label: left >= 0 ? 'Left over' : 'Beyond income', value: Math.abs(left) }]),
    ].map(s => ({ ...s, share: s.value / denom }));

    return { yr: r.yr, basis: spendBasis ? 'spend' : net ? 'net' : 'gross', denom, gross, netTC, tax, pretax, spend, oneOff, left,
      overspent: left < 0, tiers, segments,
      // Everything that is not "left over" or "beyond income" — checked to add to the denominator.
      accounted: spendBasis ? spend : (net ? 0 : tax + pretax) + spend + left };
  }

  // The plan's income for the months a ledger period covers. The ledger records what landed in
  // accounts — net pay, no Stripe vests, no gross — so it cannot say what a category is a share
  // of GROSS income. The plan can, and it is the same income the look-ahead card divides by, so
  // the two surfaces agree. Each month takes a twelfth of its year; the month in progress takes
  // the share of a twelfth that has elapsed, matching how its spending is counted.
  // `ok` is false when any month falls outside the plan, rather than guessing at its income.
  function periodIncome(months, R, opts) {
    const o = opts || {}, partial = o.partial || null, frac = Number(o.fraction);
    let gross = 0, net = 0, weight = 0;
    for (const m of months || []) {
      const key = String(m.month != null ? m.month : m);
      const row = (R || []).find(r => r.yr === Number(key.slice(0, 4)));
      if (!row || !(Number(row.gross) > 0)) return { ok: false, gross: 0, net: 0, weight: 0 };
      const w = key === partial ? (Number.isFinite(frac) ? frac : 1) : 1;
      gross += row.gross / 12 * w; net += (Number(row.netTC) || 0) / 12 * w; weight += w;
    }
    return { ok: weight > 0, gross, net, weight };
  }

  const api = { periodIncome, TIERS, FIXED_LIVING, ESSENTIAL_LIVING, tierOfLiving, LIVING_LABEL, compute };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlannerIncomeShare = api;
})(typeof window !== 'undefined' ? window : this);
