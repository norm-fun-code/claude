'use strict';
// ═══ SHARED ACROSS SCENARIOS ═══
// Most of what separates one scenario from another is a choice — how much to spend on dining,
// when to buy, what the market does. A lot of it is not: insurance, utilities, groceries, medical,
// childcare and tuition are the same bills in every future you might compare. Left to be copied
// into each saved scenario they drift apart by accident, and a comparison then measures the drift.
//
// So a group of lines can be SHARED: its figures live in the live plan only and every scenario reads
// them from there. This is the same arrangement the opening balances and the grant ledger already
// have — stripped on the way into a saved scenario, attached on the way out — extended to expense
// lines. Nothing here runs unless a group is switched on, and nothing is switched on by default.
//
// WHAT THIS DOES NOT DO: decide anything. Which groups to share is the household's call; housing is
// offered but off by default, because rent-versus-buy is exactly what cases are usually made to compare.

(function (root) {
  const PIN = /^living([A-Z][a-z]+)Y\d+$/;
  const catOfPin = k => { const m = PIN.exec(k); return m ? m[1][0].toLowerCase() + m[1].slice(1) : null; };

  const GROUPS = [
    { key: 'household', label: 'Household & inflation', recommended: false,
      note: 'Same family timeline, spending inflation and one-off costs. With all non-housing groups shared, living costs stay on the NYC budget regardless of housing.',
      lines: ['oneoff'], params: ['planStartYear','numKids','kid1Birth','kid2Birth','kid3Birth','kid4Birth',
        'expenseInflation','nycFamilyBudget','sharedBudgetIncome', ...Array.from({length:11},(_,i)=>'expenseAdjY'+i)] },
    { key: 'fixed', label: 'Fixed lines', recommended: true,
      note: 'Insurance, utilities & phone, transit, auto',
      lines: ['insurance', 'utilities', 'transit', 'auto'],
      params: ['baseInsurance', 'baseUtilsPhoneNet', 'baseTransit', 'baseAuto'] },
    { key: 'essential', label: 'Everyday essentials', recommended: true,
      note: 'Groceries, medical',
      lines: ['groceries', 'medical'], params: ['baseGroceries', 'baseMedical'] },
    { key: 'childcare', label: 'Childcare', recommended: true,
      note: 'The monthly rate and when it starts',
      lines: [], params: ['childcareMonthly', 'childcareStartMonths'] },
    { key: 'tuition', label: 'Tuition', recommended: true,
      note: 'School ages and tuition inflation',
      lines: [], params: ['yeshivaStartAge', 'yeshivaEndAge', 'kid1YeshivaStartAge', 'tuitionInflation'] },
    { key: 'housing', label: 'Housing', recommended: false,
      note: 'Rent or buy, price, rate, upkeep. Off by default: renting versus buying is what cases usually compare.',
      lines: [],
      params: ['housingMode', 'nycRent', 'rentInflation', 'rentCap', 'homePrice', 'downPctg', 'mortgageRate',
        'homePurchaseYear', 'propTaxRate', 'propTaxBase', 'maintBase', 'homeInsuranceAnnual', 'homeInsuranceRate',
        'movingCosts', 'closingLegalFees', 'closingOtherFees', 'titleInsuranceRate',
        'suburbAutoBoost', 'suburbInsBoost', 'suburbUtilBoost'] },
    { key: 'choice', label: 'Discretionary', recommended: false,
      note: 'Dining, shopping, clothing, vacations, entertainment, charity, misc. Usually what cases change, so off by default.',
      lines: ['dining', 'shopping', 'clothing', 'vacations', 'entertainment', 'charity', 'misc'],
      params: ['baseDining', 'baseShopping', 'clothingShare', 'baseVacations', 'postKidVacations',
        'baseMisc', 'baseCharity', 'baseEntertainment'] },
  ];
  const PARAM_LABEL = {
    baseInsurance: 'Insurance', baseUtilsPhoneNet: 'Utilities & phone', baseTransit: 'Transit', baseAuto: 'Auto',
    baseGroceries: 'Groceries', baseMedical: 'Medical', childcareMonthly: 'Childcare rate', childcareStartMonths: 'Childcare start',
    yeshivaStartAge: 'School start age', yeshivaEndAge: 'School end age', kid1YeshivaStartAge: 'Kid 1 school start',
    tuitionInflation: 'Tuition inflation', housingMode: 'Rent or buy', nycRent: 'Rent', homePrice: 'Home price',
    mortgageRate: 'Mortgage rate', homePurchaseYear: 'Purchase year', downPctg: 'Down payment', maintBase: 'Home upkeep',
    baseDining: 'Dining', baseShopping: 'Shopping', clothingShare: 'Clothing share', baseVacations: 'Vacations',
    postKidVacations: 'Vacations with kids', baseMisc: 'Misc', baseCharity: 'Charity', baseEntertainment: 'Entertainment',
  };

  // Normalised: every group present, a plain boolean each. Absent config means nothing shared.
  function config(src) {
    const c = src && src.sharedLines, groups = {};
    for (const g of GROUPS) groups[g.key] = !!(c && c.groups && c.groups[g.key]);
    return { groups, any: Object.values(groups).some(Boolean) };
  }
  const restrict = (cfg, keys) => {
    const groups = {};
    for (const g of GROUPS) groups[g.key] = !!(cfg.groups[g.key] && (!keys || keys.includes(g.key)));
    return { groups, any: Object.values(groups).some(Boolean) };
  };
  const sets = cfg => {
    const params = new Set(), lines = new Set();
    for (const g of GROUPS) if (cfg.groups[g.key]) { g.params.forEach(k => params.add(k)); g.lines.forEach(l => lines.add(l)); }
    return { params, lines };
  };
  const inShared = (k, s) => s.params.has(k) || (catOfPin(k) !== null && s.lines.has(catOfPin(k)));

  // What the live plan holds for the shared groups.
  function extract(src, cfg) {
    const s = sets(cfg), flat = {}, rules = {};
    for (const k of Object.keys(src || {})) if (inShared(k, s)) flat[k] = src[k];
    for (const cat of s.lines) if (src.budgetRules && src.budgetRules[cat]) rules[cat] = JSON.parse(JSON.stringify(src.budgetRules[cat]));
    const items = (Array.isArray(src.planItems) ? src.planItems : []).filter(i => i && s.lines.has(i.category)).map(i => ({ ...i }));
    return { flat, rules, items, sets: s };
  }

  function without(params, s) {
    const o = { ...params };
    for (const k of Object.keys(o)) if (inShared(k, s)) delete o[k];
    if (o.budgetRules) {
      o.budgetRules = { ...o.budgetRules };
      for (const cat of s.lines) delete o.budgetRules[cat];
    }
    if (Array.isArray(o.planItems)) o.planItems = o.planItems.filter(i => !(i && s.lines.has(i.category)));
    return o;
  }

  // Into a saved scenario: the shared groups are not stored there, nor is the setting itself.
  function strip(params) {
    const cfg = config(params);
    const o = cfg.any ? without(params, sets(cfg)) : { ...params };
    delete o.sharedLines;
    return o;
  }

  // Out of a saved scenario: the shared groups come from the live plan, and so does the setting.
  // `only` limits it to named groups — used to freeze one group's figures into every scenario when
  // it stops being shared, so switching sharing off never changes a scenario's projection.
  function attach(params, live, only) {
    const full = config(live), cfg = only ? restrict(full, only) : full;
    if (!cfg.any) return params;
    const ex = extract(live, cfg), o = without(params, ex.sets);
    Object.assign(o, ex.flat);
    if (Object.keys(ex.rules).length || o.budgetRules) o.budgetRules = { ...(o.budgetRules || {}), ...ex.rules };
    if (ex.items.length || Array.isArray(o.planItems)) o.planItems = [...(Array.isArray(o.planItems) ? o.planItems : []), ...ex.items];
    if (!only) o.sharedLines = live.sharedLines;
    return o;
  }

  // What would change in a saved scenario if these groups started being shared: the figures it
  // holds that differ from the live plan's. `defaults` fills a key the scenario never set.
  function differences(params, live, groupKeys, defaults) {
    const cfg = restrict({ groups: Object.fromEntries(GROUPS.map(g => [g.key, true])) }, groupKeys);
    const s = sets(cfg), out = [], d = defaults || {};
    for (const k of s.params) {
      const a = params[k] !== undefined ? params[k] : d[k], b = live[k] !== undefined ? live[k] : d[k];
      if (a !== undefined && b !== undefined && JSON.stringify(a) !== JSON.stringify(b))
        out.push({ kind: 'value', key: k, label: PARAM_LABEL[k] || k, scenario: a, live: b });
    }
    for (const cat of s.lines) {
      const a = JSON.stringify((params.budgetRules || {})[cat] || null), b = JSON.stringify((live.budgetRules || {})[cat] || null);
      if (a !== b) out.push({ kind: 'rules', key: cat, label: cat });
    }
    const pins = o => Object.keys(o || {}).filter(k => catOfPin(k) && s.lines.has(catOfPin(k))).sort().map(k => [k, o[k]]);
    if (JSON.stringify(pins(params)) !== JSON.stringify(pins(live))) out.push({ kind: 'pins', key: 'pins', label: 'yearly pins' });
    const items = o => JSON.stringify((Array.isArray(o.planItems) ? o.planItems : []).filter(i => i && s.lines.has(i.category)));
    if (items(params) !== items(live)) out.push({ kind: 'items', key: 'items', label: 'plan items' });
    return out;
  }

  const groupOf = (cat) => { const g = GROUPS.find(x => x.lines.includes(cat)); return g ? g.key : null; };
  const isShared = (live, cat) => { const g = groupOf(cat); return !!(g && config(live).groups[g]); };

  const api = { GROUPS, PARAM_LABEL, config, extract, strip, attach, differences, groupOf, isShared, catOfPin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlannerShared = api;
})(typeof window !== 'undefined' ? window : this);
