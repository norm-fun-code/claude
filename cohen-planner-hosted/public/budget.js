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
    : { LIV_KEYS, LIV_OVERRIDE_MAX, livingCategoryKey, budgetSegment, budgetValue, commonHousehold, locationSpendingFactor };
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

  // The emergency fund is set the same way as a spending line (a dollar figure or a share of income,
  // for one year or from a year on) but it is not spending, so it keeps its own pin key and the
  // projection never reads it: it decides how a year's left-over money is divided, nothing more.
  const EMERGENCY = 'emergency';
  const emergencyKey = i => `savingEmergencyY${i}`;
  const keyFor = (category, i) => category === EMERGENCY ? emergencyKey(i) : M.livingCategoryKey(category, i);

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
    if (!M.LIV_KEYS.includes(c.category) && c.category !== EMERGENCY) return { ok: false, error: 'Unknown line.' };
    if (i < 0 || i > M.LIV_OVERRIDE_MAX) return { ok: false, error: 'That year is outside the plan.' };
    const basis = c.basis === 'gross' ? 'gross' : 'net';
    const income = c.income || {};
    const base = Number(basis === 'gross' ? income.gross : income.net) || 0;
    const factor=M.locationSpendingFactor(P,c.category,c.year);
    const input = {...(c.input || { kind: 'clear' })};
    if(input.kind==='amount')input.annual/=factor;
    if(input.kind==='pct')input.pct/=factor;
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
    if (seg.kind === 'pct' && M.commonHousehold(P) && category !== EMERGENCY)
      return `${(seg.value * 100).toFixed(1).replace(/\.0$/, '')}% of the shared reference ${seg.basis === 'gross' ? 'gross' : 'net'} income schedule`;
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
    { key: 'fixed', label: 'Fixed costs',
      note: 'Housing, childcare, tuition, insurance, utilities & phone, transit, auto, and the essentials: groceries and medical',
      lines: ['housing', 'childcare', 'tuition', 'insurance', 'utilities', 'transit', 'auto', 'groceries', 'medical'] },
    { key: 'discretionary', label: 'Discretionary',
      note: 'Choices: dining, shopping, clothing, vacations, entertainment, charity, misc',
      lines: ['dining', 'shopping', 'clothing', 'vacations', 'entertainment', 'charity', 'misc'] },
    { key: 'saving', label: 'Savings', computed: true,
      note: 'The emergency fund: a share of income set aside each year, filled before anything is invested', lines: [] },
    { key: 'investing', label: 'Investments', computed: true,
      note: 'Fidelity brokerage, which takes all the cash left once savings are set aside, and Stripe shares kept', lines: [] },
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
    const sy = P.planStartYear || 2026;
    const floor = Number(P.liquidReserveFloor) || 0;
    const liqBegin = prev ? prev.liq : Number(P.startingLiquid) || 0;
    const flow = Number(r.flowFull) || 0;
    const excess = Math.max(0, flow), deficit = Math.max(0, -flow);
    const stripeRet = Math.min(Math.max(0, Number(r.sRet) || 0), excess);
    const toCash = excess - stripeRet;
    const reserveGap = Math.max(0, floor - liqBegin);

    // What the emergency fund is asked to take this year: the figure you pinned for the year, else the
    // rule in force, else — if you have set nothing — only what it takes to refill to the reserve floor.
    const pin = Number(P[emergencyKey(year - sy)]);
    const pinned = P[emergencyKey(year - sy)] !== undefined && P[emergencyKey(year - sy)] !== null
      && P[emergencyKey(year - sy)] !== '' && Number.isFinite(pin);
    const ruled = pinned ? null : M.budgetValue(P, EMERGENCY, year, { net: r.netTC, gross: r.gross });
    const src = pinned ? 'pin' : ruled !== null ? 'rule' : 'model';
    const target = Math.max(0, Math.round(pinned ? pin : ruled !== null ? ruled : reserveGap));

    // Savings come first. They are paid from the cash left over, and if that is not enough, from the
    // Stripe shares the plan would otherwise keep (selling some of them is what funding it would take).
    // Nothing can be saved that the year does not leave over.
    const saved = Math.min(target, excess);
    const fromCash = Math.min(saved, toCash), fromShares = saved - fromCash;
    const stripe = stripeRet - fromShares, brokerage = toCash - fromCash;
    const k401 = Math.round(Number(P.pretax401k) || 0);
    const liv = r.livFullParts || {};
    const fixed = (r.hFull || 0) + (r.ccFull || 0) + (r.tuFull || 0)
      + BUCKETS[0].lines.filter(k => liv[k] != null).reduce((t, k) => t + liv[k], 0);
    return {
      year, flow, excess, deficit,
      investing: { stripe: Math.round(stripe), portfolio: Math.round(brokerage), total: Math.round(stripe + brokerage), k401 },
      saving: { target, src, total: Math.round(saved), fromCash: Math.round(fromCash), fromShares: Math.round(fromShares),
        shortfall: Math.round(Math.max(0, target - saved)), reserveGap: Math.round(reserveGap) },
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
  // What has been set aside for the emergency fund from the plan's first year through `year`, and what
  // that is in months of that year's fixed costs.
  function emergencySaved(P, R, year) {
    let total = 0;
    for (const r of R) if (r.yr <= year) total += allocation(P, R, r.yr).saving.total;
    const a = allocation(P, R, year);
    return { total, months: a && a.fixedPerMonth > 0 ? Math.round(total / a.fixedPerMonth * 10) / 10 : null };
  }

  // ── Actual against budget ──────────────────────────────────────────────────
  // The imported records speak in the bank's categories; the budget speaks in lines. The bridge is a
  // list of plain rules, first match wins, and a map of your own corrections that always beats them.
  // Anything that matches nothing is reported as unmapped rather than guessed at, so the totals never
  // quietly omit or invent spending.
  const CATEGORY_RULES = [
    ['housing', /\b(rent|mortgage|hoa|property tax|co-?op|condo fee)\b/],
    ['childcare', /child ?care|day ?care|nanny|babysit|preschool|after.?school/],
    ['tuition', /tuition|school|education|yeshiva/],
    ['groceries', /grocer|supermarket/],
    ['dining', /restaurant|dining|coffee|\bbars?\b|food delivery|takeout|fast food/],
    ['clothing', /cloth|apparel|shoe/],
    ['vacations', /travel|vacation|hotel|airfare|flight/],
    ['entertainment', /entertain|recreation|movie|music|streaming|subscription|hobby|sport|fitness|gym/],
    ['charity', /charit|donation|tithe|giving/],
    ['medical', /medical|health|dental|doctor|pharmac|vision/],
    ['insurance', /insurance/],
    ['utilities', /phone|internet|cable|gas (&|and) electric|electric|utilit|water|wireless/],
    ['transit', /transit|taxi|ride ?share|uber|lyft|parking|toll|public transport|\bbus\b|\btrain\b/],
    ['auto', /\bauto\b|\bcar\b|vehicle|fuel|^gas$|gas station|car wash/],
    ['misc', /\bgifts?\b|misc|uncategor|\bfees?\b|bank/],
    ['shopping', /shopping|personal|home|household|electronic|furnish|garden|pet|baby|kids/],
  ];
  const LINES = BUCKETS.flatMap(b => b.lines);
  const normCat = n => String(n == null ? '' : n).trim().toLowerCase();
  // 'ignore' keeps a category out of the comparison on purpose.
  function lineOfCategory(name, overrides) {
    const key = normCat(name), o = overrides && overrides[key];
    if (o && (LINES.includes(o) || o === 'ignore')) return o;
    for (const [line, re] of CATEGORY_RULES) if (re.test(key)) return line;
    return null;
  }

  // Closed months of `year` that the records cover, from the spending summary the page already holds.
  // The month in progress is left out: a half-finished month reads as a saving that has not happened.
  function actuals(spend, year, overrides) {
    if (!spend || spend.error || !Array.isArray(spend.months)) return null;
    const asOf = String(spend.endDate || '').slice(0, 7);
    const months = spend.months.filter(m => String(m.month).slice(0, 4) === String(year) && (!asOf || String(m.month) < asOf));
    if (!months.length) return null;
    const perLine = {}, unmapped = {}, ignored = {};
    let total = 0;
    for (const m of months) for (const c of (m.categories || [])) {
      const net = Number(c.net) || 0, line = lineOfCategory(c.name, overrides);
      if (line === 'ignore') { ignored[c.name] = (ignored[c.name] || 0) + net; continue; }
      total += net;
      if (line) perLine[line] = (perLine[line] || 0) + net;
      else unmapped[c.name] = (unmapped[c.name] || 0) + net;
    }
    const n = months.length;
    const per = v => v / n;
    return {
      year, months: n, through: months[months.length - 1].month,
      total, perMonth: per(total),
      lines: Object.fromEntries(Object.entries(perLine).map(([k, v]) => [k, { total: v, perMonth: per(v) }])),
      unmapped: Object.entries(unmapped).map(([name, v]) => ({ name, total: v, perMonth: per(v) })).sort((a, b) => b.total - a.total),
      unmappedTotal: Object.values(unmapped).reduce((t, v) => t + v, 0),
    };
  }

  // Pace against budget for one line: both per month, so a part-year of records compares like for like.
  // Within 10% (and $50 a month) is on pace; the labels never call a miss a failure.
  function variance(budgetPerMonth, actualPerMonth) {
    const b = Number(budgetPerMonth) || 0, a = Number(actualPerMonth) || 0, diff = a - b;
    if (Math.abs(diff) < 50 || (b > 0 && Math.abs(diff) / b < 0.10)) return { status: 'on', diff, pct: b > 0 ? diff / b : null };
    if (b <= 0) return { status: 'unplanned', diff, pct: null };
    return { status: diff > 0 ? 'over' : 'under', diff, pct: diff / b };
  }

  // ── Everything you have changed ────────────────────────────────────────────
  // A rule rolls forward silently, so it is easy to forget it is there. This lists every one — a rule
  // and where it ends, a pin for a single year, a plan item — in one flat list that a screen can show
  // beside the line it belongs to and again as a whole, so nothing you changed is out of sight.
  const ORDER = [...BUCKETS.flatMap(b => b.lines), EMERGENCY];
  function overrides(P) {
    const sy = P.planStartYear || 2026, end = P.planEndYear || 2058, out = [];
    const kinds = M.BUDGET_KINDS || ['amount', 'pct', 'model'];
    for (const cat of ORDER.filter(c => c !== 'housing' && c !== 'childcare' && c !== 'tuition')) {
      const raw = ((P.budgetRules || {})[cat] || []);
      const segs = raw.map((seg, index) => ({ seg, index }))
        .filter(x => x.seg && kinds.includes(x.seg.kind) && Number.isFinite(Number(x.seg.from)))
        .sort((a, b) => Number(a.seg.from) - Number(b.seg.from));
      segs.forEach((x, i) => {
        const next = segs[i + 1];
        out.push({ type: 'rule', category: cat, from: Number(x.seg.from), to: next ? Number(next.seg.from) - 1 : end, seg: x.seg, ref: x.index });
      });
      for (let i = 0; i <= M.LIV_OVERRIDE_MAX; i++) {
        const key = keyFor(cat, i), v = P[key];
        if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)))
          out.push({ type: 'pin', category: cat, from: sy + i, to: sy + i, value: Number(v), ref: key });
      }
    }
    (Array.isArray(P.planItems) ? P.planItems : []).forEach((it, i) => {
      if (it) out.push({ type: 'item', category: it.category, label: it.label, from: Number(it.from), to: Number(it.to), amount: Number(it.amount), grow: it.grow !== false, ref: i });
    });
    const rank = c => { const i = ORDER.indexOf(c); return i < 0 ? 999 : i; };
    return out.sort((a, b) => rank(a.category) - rank(b.category) || a.from - b.from);
  }
  // One sentence for one override. `fmt` formats dollars; amounts are yearly figures.
  function overrideText(P, o, fmt) {
    if (o.type === 'pin') return `${fmt(o.value)} a year, for ${o.from} only`;
    if (o.type === 'item') return `${o.label || 'Plan item'}: ${fmt(o.amount)}${o.from === o.to ? ' once' : ' a year'}${o.grow && o.from !== o.to ? ', growing with inflation' : ''}`;
    const seg = o.seg, basis = seg.basis === 'gross' ? 'gross' : 'net';
    if (seg.kind === 'model') return "back to the model's figure";
    if (seg.kind === 'pct') return `${(seg.value * 100).toFixed(1).replace(/\.0$/, '')}% of ${basis} income, every year`;
    const sized = seg.sized ? ` (sized from ${(seg.sized.pct * 100).toFixed(1).replace(/\.0$/, '')}% of ${seg.sized.basis === 'gross' ? 'gross' : 'net'} income)` : '';
    return `${fmt(seg.value)} a year in ${seg.from}, then rising with inflation${sized}`;
  }

  // ── Call-outs for a whole group, and for the bottom line ─────────────────
  // The same idea as the per-line call-outs (is this out of bounds, high or low?) one level up. The
  // ranges are the usual guidance for a household's take-home pay: fixed costs 50-60%, discretionary
  // 20-35%, and 10% or more kept. They are a ruler, not a verdict, and a plan that saves early and
  // draws down later will rightly sit outside them in some years; where it does, the text says so.
  const usd = v => '$' + Math.round(v).toLocaleString('en-US');
  const pc = v => (v * 100).toFixed(0) + '%';
  function groupChecks(P, R, year) {
    const i = R.findIndex(r => r.yr === year);
    if (i < 0) return {};
    const r = R[i], net = Number(r.netTC) || 0, gross = Number(r.gross) || 0;
    if (!(net > 0)) return {};
    const out = {};
    const liv = r.livFullParts || {};
    const spend = lines => lines.reduce((t, k) => t + (k === 'housing' ? r.hFull : k === 'childcare' ? r.ccFull : k === 'tuition' ? r.tuFull : (liv[k] || 0)), 0);
    const group = key => BUCKETS.find(b => b.key === key).lines;
    const extra = Object.keys(liv).filter(k => bucketOf(k) === 'discretionary' && !group('discretionary').includes(k));
    const fixed = spend(group('fixed')) / net, disc = (spend(group('discretionary')) + spend(extra)) / net;
    if (fixed > 0.60) out.fixed = { status: 'high', text: `Fixed costs are ${pc(fixed)} of net income, above the usual 50–60%. Less room to adjust when something changes.` };
    else if (fixed < 0.35) out.fixed = { status: 'low', text: `Fixed costs are only ${pc(fixed)} of net income, below the usual 50–60%. Worth checking nothing is missing.` };
    if (disc > 0.35) out.discretionary = { status: 'high', text: `Discretionary spending is ${pc(disc)} of net income, above the usual 20–35%.` };
    else if (disc < 0.15) out.discretionary = { status: 'low', text: `Discretionary spending is only ${pc(disc)} of net income, below the usual 20–35%. Lean, or some lines are under-budgeted.` };
    // Housing against what lenders look at: its share of gross income.
    if (gross > 0 && r.hFull / gross > 0.28)
      out.housing = { status: 'high', text: `Housing is ${pc(r.hFull / gross)} of gross income (${usd(r.hFull / 12)} a month), above the 28% lenders usually look for.` };
    const a = allocation(P, R, year);
    const phase = phases(R).find(ph => year >= ph.from && year <= ph.to);
    const planned = phase && phase.kind === 'draw' ? ` The plan expects to draw down in ${phase.from}–${phase.to}, so this one is by design.` : '';
    if (a && a.deficit > 0) out.bottom = { status: 'draw', text: `${year} spends ${usd(a.deficit)} more than it takes in, met by selling Stripe shares and drawing on the brokerage.${planned}` };
    else if (a && a.excess / net < 0.10) {
      const kept = a.excess / net;
      out.investing = { status: 'low', text: `Only ${pc(kept)} of net income is left to save and invest, below the usual 10% or more.${planned}` };
    }
    if (a && a.reserveMonths != null && a.reserveMonths < 3)
      out.saving = { status: 'low', text: `The ${usd(a.reserveFloor)} reserve floor covers only ${a.reserveMonths} months of fixed costs; the usual guidance is 3–6 months.` };
    return out;
  }

  const api = { groupChecks, overrides, overrideText, CATEGORY_RULES, lineOfCategory, actuals, variance, BUCKETS, EMERGENCY, emergencyKey, bucketOf, allocation, allocationSeries, emergencySaved, modelPlan, parseInput, edit, describe, funding, phases, headroom, feasible };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlannerBudget = api;
})(typeof window !== 'undefined' ? window : this);
