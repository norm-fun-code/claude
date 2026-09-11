import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync } from 'node:fs';
const B = require('../public/bridge.js');
const A = require('../public/accounts.js');

// The cockpit shows net worth twice — observed at the top, projected on the chart — and they
// do not agree. The bridge exists to say why, in lines that add up. If they ever stop adding
// up, the explanation is worse than no explanation at all.
const accounts = [
  { id: '1', name: 'Chase Checking', category: 'cash', balance: 180000 },
  { id: '2', name: 'Fidelity Brokerage', category: 'investment', balance: 520000 },
  { id: '3', name: 'Stripe Equity', category: 'other_asset', balance: 614000 },
  { id: '4', name: 'Stripe 401(k)', category: 'retirement', balance: 240000 },
  { id: '5', name: 'Amex', category: 'liability', balance: -9000 },
];
// Real rows always carry netWorth; the fixture has to as well, or it is not a row.
const row = (o) => ({ ...o, netWorth: o.nw + o.k401 });
const R = [row({ yr: 2026, nw: 1180000, k401: 230000, liq: 900000, sEnd: 280000, eq: 0 })];
const P = { startingLiquid: 1100000, startingStripeEquity: 0, k401Start: 210000 };
const run = (accts = accounts, ov = {}, opts = {}) =>
  B.bridge({ summary: A.summarize(accts, ov), R, P, year: 2026, accountsAvailable: true, ...opts });

describe('bridging observed net worth to projected wealth', () => {
  it('walks from the hero figure to the chart figure, and the steps add up', () => {
    const b = run();
    expect(b.available).toBe(true);
    expect(b.lines[0].running).toBe(b.observed);
    const last = b.lines[b.lines.length - 1];
    expect(last.running).toBe(b.projected);
    // Every signed step, summed onto the opening figure, must land exactly on the close.
    const walked = b.lines.reduce((n, l) => n + (l.value == null ? 0 : l.value), 0);
    expect(b.observed + walked).toBe(b.projected);
  });

  it('keeps each running total consistent with the step before it', () => {
    const b = run();
    let n = null;
    for (const l of b.lines) {
      if (n != null && l.value != null) n += l.value;
      else if (l.running != null) n = l.running;
      if (l.running != null) expect(l.running, l.key).toBe(n);
    }
  });

  it('separates the causes, and every fixable one offers the fix', () => {
    const withOdd = [...accounts, { id: '9', name: 'Weird thing', category: 'other', balance: 35000 }];
    const b = run(withOdd);
    const kinds = b.lines.map(l => l.kind);
    expect(kinds).toContain('composition');   // unclassified money the plan has no bucket for
    expect(kinds).toContain('plan');          // the plan's opening figures are stale
    expect(kinds).toContain('time');          // today is not 31 December
    // Time is the only difference nobody can act on. Everything else names its remedy.
    for (const l of b.lines.filter(x => x.kind === 'plan' || x.kind === 'composition'))
      expect(l.action, l.key).toBeTruthy();
    expect(b.lines.find(l => l.kind === 'time').action).toBeUndefined();
  });
});

describe('the composition gap', () => {
  it('sets unclassified money aside instead of silently dropping it', () => {
    const withOdd = [...accounts, { id: '9', name: 'Weird thing', category: 'other', balance: 35000 }];
    const b = run(withOdd);
    const line = b.lines.find(l => l.key === 'unclassified');
    expect(line.value).toBe(-35000);          // removed on the way to the comparable subset
    expect(line.action).toBe('classify');     // …and the fix is named
    expect(b.comparable).toBe(run().comparable);  // classifying it is the only way in
  });

  it('counts debt inside the comparable subset, now that the projection carries it', () => {
    // It used to be added back as something the model simply did not have, which dressed a
    // real liability up as a difference of definition.
    const b = run();
    expect(b.comparable).toBe(b.observed);            // nothing unclassified here
    expect(b.lines.find(l => l.key === 'debt')).toBeUndefined();
  });

  it('reports a plan carrying no float as a gap to reconcile, not a fact of life', () => {
    const b = run();
    const line = b.lines.find(l => l.key === 'debtGap');
    expect(line.kind).toBe('plan');                   // fixable, not structural
    expect(line.action).toBe('reconcile');
    expect(line.value).toBe(9000);                    // the plan's opening is 9k lighter
    expect(line.note).toMatch(/float — a permanent offset, not a debt that amortises/);
  });

  it('stops mentioning debt once the plan carries the balance you actually hold', () => {
    const b = B.bridge({ summary: A.summarize(accounts, {}), R, P: { ...P, otherDebt: 9000 },
      year: 2026, accountsAvailable: true });
    expect(b.lines.find(l => l.key === 'debtGap')).toBeUndefined();
  });

  it('counts a Stripe 401(k) as retirement on both sides of the bridge', () => {
    // The classic way to make these two numbers disagree for a reason nobody can find.
    const c = B.comparableObserved(A.summarize(accounts, {}));
    expect(c.retirement).toBe(240000);
    expect(c.stripe).toBe(614000);
    expect(c.privateOther).toBe(0);
  });
});

describe('the plan gap — the one worth acting on', () => {
  it('names the direction, and what it does to every later year', () => {
    const b = run();
    expect(b.planGap).toBe(235000);
    expect(b.aligned).toBe(false);
    expect(b.headline).toMatch(/accounts hold \$235,000 MORE/);
    expect(b.headline).toMatch(/understates every year/);
  });

  it('reverses the wording when the plan is the optimistic one', () => {
    const thin = accounts.map(a => a.id === '2' ? { ...a, balance: 100000 } : a);
    const b = run(thin);
    expect(b.planGap).toBeLessThan(0);
    expect(b.headline).toMatch(/plan assumes it starts 2026 with/);
    expect(b.headline).toMatch(/overstates every year/);
  });

  it('stops crying misalignment once the plan is within a thousand dollars', () => {
    // Assets AND the carried balance both have to match. A plan that nails every asset but
    // carries no float is still off by the float, and should still say so.
    const tuned = { startingLiquid: 700000, startingStripeEquity: 614000, k401Start: 240000, otherDebt: 9000 };
    const b = B.bridge({ summary: A.summarize(accounts, {}), R, P: tuned, year: 2026, accountsAvailable: true });
    expect(b.planGap).toBe(0);
    expect(b.aligned).toBe(true);
    expect(b.headline).toMatch(/within \$1k/);
    expect(b.lines.find(l => l.kind === 'plan')).toBeUndefined();

    const noFloat = B.bridge({ summary: A.summarize(accounts, {}), R, P: { ...tuned, otherDebt: 0 },
      year: 2026, accountsAvailable: true });
    expect(noFloat.aligned).toBe(false);
    expect(noFloat.lines.find(l => l.key === 'debtGap').value).toBe(9000);
  });

  it('reads a later year from the prior year close, not the typed assumptions', () => {
    const R2 = [...R, row({ yr: 2027, nw: 1300000, k401: 260000, liq: 980000, sEnd: 320000, eq: 0 })];
    const b = B.bridge({ summary: A.summarize(accounts, {}), R: R2, P, year: 2027, accountsAvailable: true });
    expect(b.opening).toBe(1410000);          // 2026's close, k401 included
    expect(b.projected).toBe(1560000);
    expect(b.lines.find(l => l.kind === 'plan').note).toMatch(/close of 2026/);
  });
});

describe('when the observed side cannot be trusted', () => {
  it('refuses to bridge at all without account balances', () => {
    const b = B.bridge({ summary: null, R, P, year: 2026, accountsAvailable: false });
    expect(b.available).toBe(false);
    expect(b.projected).toBe(1410000);        // the projection still stands on its own
    expect(b.reason).toMatch(/unavailable/);
  });

  it('still bridges when a balance is missing, but says the total is short', () => {
    const gappy = [...accounts, { id: '9', name: 'Dead broker', category: 'investment' }];
    const b = run(gappy);
    expect(b.available).toBe(true);
    expect(b.caveats.join(' ')).toMatch(/1 account balance could not be read/);
  });

  it('discloses money parked in hidden accounts', () => {
    const b = run(accounts, { 1: { hidden: true } });
    expect(b.caveats.join(' ')).toMatch(/\$180,000 sits in hidden accounts/);
  });

  it('says nothing when there is nothing to disclose', () => {
    expect(run().caveats).toEqual([]);
  });

  it('reports a year it does not have rather than guessing one', () => {
    const b = B.bridge({ summary: A.summarize(accounts, {}), R, P, year: 2099, accountsAvailable: true });
    expect(b.available).toBe(false);
    expect(b.reason).toMatch(/not in the projection/);
  });
});

// The two endpoints are numbers the reader already has on screen. Showing a signed step
// beside one invites reading an anchor as a movement.
describe('the endpoints are anchors, not steps', () => {
  it('gives neither endpoint a delta', () => {
    const b = run();
    expect(b.lines[0].value).toBe(null);
    expect(b.lines[b.lines.length - 1].value).toBe(null);
  });

  it('starts on the hero figure and ends on the chart figure', () => {
    const b = run();
    expect(b.lines[0].running).toBe(1545000);            // what the cockpit hero shows
    expect(b.lines[b.lines.length - 1].running).toBe(1410000);  // what the chart shows
  });
});

// The bridge is only worth building if it is actually on the page, under the chart that
// disagrees with the hero.
describe('the bridge is wired into the cockpit', () => {
  const cockpit = readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  it('loads the module before the cockpit that calls it', () => {
    expect(html).toContain('<script src="/bridge.js">');
    expect(html.indexOf('/bridge.js')).toBeLessThan(html.indexOf('/cockpit.js'));
  });

  it('renders under the trajectory chart, not somewhere else on the page', () => {
    const card = cockpit.slice(cockpit.indexOf('cp-trajectory'), cockpit.indexOf('cp-evidence'));
    expect(card).toContain('id="cp-bridge"');
  });

  it('follows the year scrub, so it explains the year actually on screen', () => {
    const scrub = cockpit.slice(cockpit.indexOf('function cockpitSelectYear'));
    expect(scrub).toContain('cockpitRenderBridge(R,year)');
  });

  it('shows exact dollars, because rounded steps do not visibly add up', () => {
    const fn = cockpit.slice(cockpit.indexOf('function cockpitRenderBridge'));
    expect(fn).toContain('{exact:true,signed:true}');
    expect(fn).toContain('{exact:true}');
    expect(fn).not.toMatch(/UI\.money\(l\.(value|running)\)/);
  });

  it('opens itself only when there is a disagreement to explain', () => {
    const fn = cockpit.slice(cockpit.indexOf('function cockpitRenderBridge'));
    expect(fn).toContain("b.aligned?'':' open'");
  });
});

// A subtotal that repeats its own input reads as a rounding error the reader goes hunting
// for. It earns its row only when something was set aside above it.
describe('the comparable subtotal', () => {
  it('is omitted when nothing was set aside', () => {
    const b = run();
    expect(b.lines.find(l => l.key === 'comparable')).toBeUndefined();
    expect(b.comparable).toBe(b.observed);
  });

  it('appears as soon as there is unclassified money to set aside', () => {
    const withOdd = [...accounts, { id: '9', name: 'Weird thing', category: 'other', balance: 35000 }];
    const b = run(withOdd);
    const sub = b.lines.find(l => l.key === 'comparable');
    expect(sub.running).toBe(b.observed - 35000);
  });
});
