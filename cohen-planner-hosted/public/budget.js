'use strict';
// ═══ BUDGET ═══
// The pure side of the Budget screen: reading what a line is doing, turning an edit into a rule,
// and answering the one question a savings target cannot — "can the plan afford this?".
//
// WHY THERE IS NO SAVINGS TARGET. This household saves hard early and draws down later, by
// design: tuition years run at a deficit while the build years run well ahead. "Save 20% every
// year" would grade the early years a triumph and the later ones a failure when both are doing
// exactly what the plan needs. What matters is whether the whole path holds, so the measure is
// HEADROOM: how much more could be spent, from a chosen year, with liquid assets never falling
// below the reserve floor in any year of the plan.

(function (root) {
  // In the browser model.js is a plain script: its functions are globals, but its `const`s live in
  // the shared global scope rather than on `window`, so they are named here rather than read off it.
  const M = typeof module !== 'undefined' && module.exports ? require('./model.js')
    : { LIV_KEYS, LIV_OVERRIDE_MAX, livingCategoryKey, budgetSegment, budgetValue, commonHousehold };
  // Read when needed, not at load: script order in the page must not decide whether this works.
  const RB = () => (typeof module !== 'undefined' && module.exports ? require('./rent-buy.js') : root.PlannerRentBuy);

  // ── Reading a line ─────────────────────────────────────────────────────────
  // What the model alone would have said: the plan with every rule and pin taken off. The
  // figure shown beside an edited line, so the distance from the plan is never hidden.
  function modelPlan(P) {
    const q = { ...P, budgetRules: {} };
    for (const k of Object.keys(q)) if (/^living[A-Z][a-z]+Y\d+$/.test(k)) delete q[k];
    return q;
  }

  // ── Turning typing into intent ─────────────────────────────────────────────
  // "1650", "$1,650", "24k" are dollars (per month or per year, whichever the screen is showing);
  // "8%" is a share of income; empty means "put it back".
  function parseInput(text, unit) {
    const raw = String(text == null ? '' : text).trim().toLowerCase().replace(/[$,\s]/g, '');
    if (raw === '') return { kind: 'clear' };
    if (raw.endsWith('%')) {
      const n = parseFloat(raw.slice(0, -1));
      return Number.isFinite(n) && n >= 0 && n <= 100 ? { kind: 'pct', pct: n / 100 } : null;
    }
    const mult = raw.endsWith('k') ? 1000 : 1;
    const n = parseFloat(mult === 1000 ? raw.slice(0, -1) : raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return { kind: 'amount', annual: Math.round(n * mult * (unit === 'month' ? 12 : 1)) };
  }

  const keyFor = (category, i) => M.livingCategoryKey(category, i);

  // An edit becomes either a PIN (one named year) or a RULE (this year, and every year after
  // until another rule starts). Nothing is mutated: the result says what to write, and what was
  // there, so the screen can offer an undo without remembering anything itself.
  //
  //   year scope   : amount → pin that figure; % → pin that share of the year's income
  //   onward scope : amount → a dollar rule from this year, growing at inflation
  //                  % (sized)  → the same, with the dollars worked out from this year's income
  //                  % (tied)   → a share of income every year, moving with it
  //                  clear → the model's figure from this year on
  // A later change you already made is left alone and reported, never silently overwritten.
  function edit(P, c) {
    const sy = P.planStartYear || 2026, i = c.year - sy;
    if (!M.LIV_KEYS.includes(c.category)) return { ok: false, error: 'Unknown line.' };
    if (i < 0 || i > M.LIV_OVERRIDE_MAX) return { ok: false, error: 'That year is outside the plan.' };
    const basis = c.basis === 'gross' ? 'gross' : 'net';
    const income = c.income || {};
    const base = Number(basis === 'gross' ? income.gross : income.net) || 0;
    const input = c.input || { kind: 'clear' };
    const pins = {}, before = { pins: {}, budgetRules: P.budgetRules || {} };
    const setPin = (k, v) => { before.pins[k] = P[k]; pins[k] = v; };
    let rules = JSON.parse(JSON.stringify(P.budgetRules || {}));
    const notes = [];

    if (c.scope === 'year') {
      const k = keyFor(c.category, i);
      if (input.kind === 'clear') setPin(k, null);
      else if (input.kind === 'amount') setPin(k, input.annual);
      else setPin(k, Math.round(input.pct * base));
    } else {
      const segs = (rules[c.category] || []).filter(s => Number(s.from) !== c.year);
      let seg;
      if (input.kind === 'clear') seg = { from: c.year, kind: 'model' };
      else if (input.kind === 'amount') seg = { from: c.year, kind: 'amount', value: input.annual };
      else if (input.tied) seg = { from: c.year, kind: 'pct', value: input.pct, basis };
      else seg = { from: c.year, kind: 'amount', value: Math.round(input.pct * base), sized: { pct: input.pct, basis } };
      segs.push(seg);
      segs.sort((a, b) => a.from - b.from);
      rules[c.category] = segs;
      // A pin on this very year would sit on top of the new rule and hide it.
      const k = keyFor(c.category, i);
      if (P[k] !== undefined && P[k] !== null && P[k] !== '') setPin(k, null);
      const laterSegs = segs.filter(s => s.from > c.year).map(s => s.from);
      const laterPins = [];
      for (let j = i + 1; j <= M.LIV_OVERRIDE_MAX; j++) {
        const v = P[keyFor(c.category, j)];
        if (v !== undefined && v !== null && v !== '') laterPins.push(sy + j);
      }
      if (laterSegs.length) notes.push({ kind: 'later-rule', years: laterSegs });
      if (laterPins.length) notes.push({ kind: 'later-pin', years: laterPins });
    }
    return { ok: true, budgetRules: rules, pins, before, notes };
  }

  // What a line is doing in a year, in words that need no knowledge of the engine.
  function describe(P, category, year, fmt) {
    const seg = M.budgetSegment(P, category, year);
    if (!seg || seg.kind === 'model') return null;
    const infl = ((Number(P.expenseInflation) || 0) * 100).toFixed(1).replace(/\.0$/, '');
    if (seg.kind === 'pct' && M.commonHousehold(P))
      return `${(seg.value * 100).toFixed(1)}% of the shared reference ${seg.basis === 'gross' ? 'gross' : 'net'} income schedule`;
    if (seg.kind === 'pct')
      return `${(seg.value * 100).toFixed(1).replace(/\.0$/, '')}% of ${seg.basis === 'gross' ? 'gross' : 'net'} income, every year`;
    const sized = seg.sized ? `${(seg.sized.pct * 100).toFixed(1).replace(/\.0$/, '')}% of ${seg.sized.basis === 'gross' ? 'gross' : 'net'} income in ${seg.from}, then ` : '';
    return `${sized}${fmt(seg.value)} in ${seg.from}, +${infl}% a year`;
  }

  // ── Where a year's money comes from ────────────────────────────────────────
  // Spending is paid from cash pay first, then from Stripe stock (vested or sold), then from
  // savings. Said this way because net income includes stock the household cannot spend until it
  // sells it — and sells it up front, which is the plan.
  function funding(r) {
    const cash = Math.max(0, Number(r.incFull) || 0);
    const stock = Math.max(0, (Number(r.netTC) || 0) - cash);
    const spend = Number(r.totEFull != null ? r.totEFull : r.totE) || 0;
    const fromCash = Math.min(spend, cash);
    const fromStock = Math.min(spend - fromCash, stock);
    const fromSavings = Math.max(0, spend - fromCash - fromStock);
    return { cash, stock, spend, fromCash, fromStock, fromSavings,
      leftover: Math.max(0, cash + stock - spend), stockShare: spend > 0 ? fromStock / spend : 0 };
  }

  // ── The shape of the plan ──────────────────────────────────────────────────
  // Runs of years that add to savings and runs that draw them down. A single year of near-zero
  // flow between two long runs is not a phase of its own, so it joins the one before.
  function phases(R) {
    const kind = r => ((r.flowFull || 0) < -0.005 * Math.max(1, r.netTC || 1) ? 'draw' : 'save');
    const runs = [];
    for (const r of R) {
      const k = kind(r), last = runs[runs.length - 1];
      if (last && last.kind === k) { last.to = r.yr; last.total += r.flowFull || 0; last.years++; }
      else runs.push({ kind: k, from: r.yr, to: r.yr, total: r.flowFull || 0, years: 1 });
    }
    const out = [];
    for (const run of runs) {
      const prev = out[out.length - 1];
      if (prev && run.years === 1 && out.length) { prev.to = run.to; prev.total += run.total; prev.years += 1; prev.mixed = true; }
      else out.push({ ...run });
    }
    return out;
  }

  // ── Headroom ───────────────────────────────────────────────────────────────
  // The most that could be added to spending, found by running the plan. `ongoing` is a yearly
  // amount from `year` (in that year's dollars, rising with inflation after); `once` is a single
  // year's. Both are judged the way the plan is: liquid assets must not fall below the reserve
  // floor in ANY year. Negative means the plan already breaks, and by how much it would take to
  // mend it. Bisection, because the answer is a threshold and the model has no closed form.
  function feasible(P, run) {
    const floor = Number(P.liquidReserveFloor) || 0;
    const { R } = run(P);
    return R.every(r => r.liq >= floor - 1);
  }
  function firstBreach(P, run) {
    const floor = Number(P.liquidReserveFloor) || 0;
    const r = run(P).R.find(x => x.liq < floor - 1);
    return r ? r.yr : null;
  }
  const BOUNDS = { ongoing: [-400000, 800000], once: [-3000000, 3000000] };
  function solve(P, run, kind, year) {
    const [lo, hi] = BOUNDS[kind];
    const ok = h => feasible({ ...P, headroomShift: h, headroomFrom: year, headroomTo: kind === 'once' ? year : null }, run);
    let value, capped = false;
    if (ok(0)) {
      if (ok(hi)) { value = hi; capped = true; }
      else {
        let a = 0, b = hi;
        for (let i = 0; i < 16; i++) { const m = (a + b) / 2; if (ok(m)) a = m; else b = m; }
        value = a;
      }
    } else if (!ok(lo)) return { value: null };
    else {
      let a = lo, b = 0;
      for (let i = 0; i < 16; i++) { const m = (a + b) / 2; if (ok(m)) a = m; else b = m; }
      value = a;
    }
    // Rounded DOWN: a threshold quoted a little too high would be a figure that breaks the plan.
    return { value: Math.floor(value / 100) * 100, capped };
  }

  function headroom(P, run, year, opts) {
    const o = opts || {};
    const stressShift = o.stressShift != null ? o.stressShift : -0.03;
    const base = { ...P, headroomShift: 0 };
    return {
      year, floor: Number(P.liquidReserveFloor) || 0,
      ongoing: solve(base, run, 'ongoing', year),
      once: solve(base, run, 'once', year),
      stress: { shift: stressShift, ongoing: solve(RB().withStripeShift(base, stressShift), run, 'ongoing', year) },
      breachYear: firstBreach(base, run),
    };
  }

  // ── The groups a year's money falls into ───────────────────────────────────
  // Three of spending, then two of what is not spent. Spending: fixed commitments, everyday
  // essentials and discretionary — lines you set. Savings is the emergency fund; investing is the
  // Fidelity brokerage (every dollar of cash left over once the emergency fund is full) and the Stripe
  // shares kept. Those two are not lines: they are what the plan does with what is left.
  const BUCKETS = [
    { key: 'fixed', label: 'Fixed commitments',
      note: 'Arrives whether or not you change how you live: housing, childcare, tuition, insurance, utilities & phone, transit, auto',
      lines: ['housing', 'childcare', 'tuition', 'insurance', 'utilities', 'transit', 'auto'] },
    { key: 'essential', label: 'Everyday essentials',
      note: 'Flexes a little, cannot be skipped: groceries and medical',
      lines: ['groceries', 'medical'] },
    { key: 'discretionary', label: 'Discretionary',
      note: 'Choices: dining, shopping, clothing, vacations, entertainment, charity, misc',
      lines: ['dining', 'shopping', 'clothing', 'vacations', 'entertainment', 'charity', 'misc'] },
    { key: 'saving', label: 'Savings', computed: true,
      note: 'The emergency fund: cash held against the unexpected, filled before anything is invested', lines: [] },
    { key: 'investing', label: 'Investing', computed: true,
      note: 'Fidelity brokerage, which takes all the cash left once the emergency fund is full, and Stripe shares kept', lines: [] },
  ];
  // A line the engine adds later lands in discretionary rather than vanishing, so the groups always
  // add up to the year's spending.
  const bucketOf = line => {
    const b = BUCKETS.find(x => x.lines.includes(line));
    return b ? b.key : 'discretionary';
  };

  // What a year's money does, in the order the plan actually does it. `excess` is the year's net
  // cash flow when positive: everything earned after tax, less everything spent. It stays as Stripe
  // shares first (the plan keeps vested shares it does not need to sell), and what is left goes to
  // the portfolio — which is the cash reserve until that is back at its floor, and then investments.
  //
  // This describes where the surplus lands; it does not change the projection. The model has one
  // liquid pool, and says so, so "savings" here is the reserve top-up and nothing is invented.
  function allocation(P, R, year) {
    const i = R.findIndex(r => r.yr === year);
    if (i < 0) return null;
    const r = R[i], prev = i > 0 ? R[i - 1] : null;
    const floor = Number(P.liquidReserveFloor) || 0;
    const liqBegin = prev ? prev.liq : Number(P.startingLiquid) || 0;
    const flow = Number(r.flowFull) || 0;
    const excess = Math.max(0, flow), deficit = Math.max(0, -flow);
    const stripe = Math.min(Math.max(0, Number(r.sRet) || 0), excess);
    const toPortfolio = excess - stripe;
    const reserveGap = Math.max(0, floor - liqBegin);
    const reserve = Math.min(toPortfolio, reserveGap);
    const invested = toPortfolio - reserve;
    const k401 = Math.round(Number(P.pretax401k) || 0);
    // Fixed costs, per month, for the reserve in months.
    const liv = r.livFullParts || {};
    const fixed = (r.hFull || 0) + (r.ccFull || 0) + (r.tuFull || 0)
      + BUCKETS[0].lines.concat(BUCKETS[1].lines).filter(k => liv[k] != null).reduce((t, k) => t + liv[k], 0);
    return {
      year, flow, excess, deficit,
      investing: { stripe: Math.round(stripe), portfolio: Math.round(invested), total: Math.round(stripe + invested), k401 },
      saving: { reserve: Math.round(reserve), reserveGap: Math.round(reserveGap), total: Math.round(reserve) },
      // A shortfall is met by selling shares, then drawing the portfolio down.
      drawn: { stripe: Math.round(Math.max(0, (Number(r.sold) || 0) + (Number(r.sHold) || 0))), total: Math.round(deficit) },
      reserveFloor: floor, liquid: Math.round(r.liq), liquidBegin: Math.round(liqBegin),
      fixedPerMonth: Math.round(fixed / 12),
      reserveMonths: fixed > 0 ? Math.round(floor / (fixed / 12) * 10) / 10 : null,
      reserveFunded: liqBegin >= floor,
    };
  }
  // The same, for every year — the strip that shows saving early and drawing down later.
  const allocationSeries = (P, R) => R.map(r => allocation(P, R, r.yr));

  const api = { BUCKETS, bucketOf, allocation, allocationSeries, modelPlan, parseInput, edit, describe, funding, phases, headroom, feasible };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlannerBudget = api;
})(typeof window !== 'undefined' ? window : this);
