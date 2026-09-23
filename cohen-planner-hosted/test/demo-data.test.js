import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Demo = require('../public/demo-data.js');
const M = require('../public/model.js');
const E = {
  Accounts: require('../public/accounts.js'), Spending: require('../public/spending.js'),
  Pace: require('../public/pace.js'), Monitors: require('../public/monitors.js'),
  TaxPlan: require('../public/tax-plan.js'), TaxRules: require('../public/tax-rules.js'),
  Liquidity: require('../public/liquidity.js'), Snapshots: require('../public/snapshots.js'), run: M.run,
};

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const D = vm.runInNewContext('(' + html.match(/const D=(\{[\s\S]*?\n\});/)[1] + ')');
const P = { ...Demo.demoDefaults(D), ...Demo.demoShape(2026), childcareStartMonths: 6 };
const NOW = '2026-09-23T15:00:00.000Z';
const state = Demo.buildDemoState(P, E, { now: NOW });
const MONEY = Object.entries(D).filter(([, v]) => typeof v === 'number' && Math.abs(v) > Demo.MONEY_FLOOR);

// ── The household ───────────────────────────────────────────────────────────
describe('the demo plan', () => {
  it('carries no real money figure', () => {
    const dd = Demo.demoDefaults(D);
    expect(MONEY.filter(([k, v]) => dd[k] === v).map(([k]) => k)).toEqual([]);
  });

  it('sets every money figure explicitly, so none is left to a scrub that can cliff', () => {
    // Left to the scrub, pay from year four came out at two thirds of year three and the
    // household drew on savings for thirty years.
    expect(MONEY.filter(([k]) => !(k in Demo.DEMO_OVERRIDES)).map(([k]) => k)).toEqual([]);
  });

  it('is a household worth showing — it does not live off its savings', () => {
    const R = M.run(P).R;
    expect(M.drawYears(R)).toBeLessThanOrEqual(3);
    expect(R.at(-1).netWorth).toBeGreaterThan(P.startingLiquid);
  });

  it('is the same on every load, so a refresh does not look like a broken app', () => {
    const again = Demo.buildDemoState(P, E, { now: NOW });
    expect(again.ledger).toEqual(state.ledger);
    expect(again.ovw.summary.netWorth).toBe(state.ovw.summary.netWorth);
  });
});

// ── Screens that read the server now read this ─────────────────────────────
describe('what each screen is given', () => {
  it('accounts that reconcile to the plan opening, so the cockpit shows no false gap', () => {
    const s = state.ovw.summary;
    expect(s.accessible).toBe(P.startingLiquid);
    expect(s.stripeVested).toBe(P.startingStripeEquity);
    expect(s.byClass.retirement.total).toBe(P.k401Start);
    expect(s.complete).toBe(true);
    expect(state.ovw.capabilities.balances.available).toBe(true);
  });

  it('holdings that add up to the brokerage balance they sit in', () => {
    const brk = state.accounts.find(a => a.id === 'demo-brk').balance;
    expect(state.investments.holdings.reduce((t, h) => t + h.value, 0)).toBe(brk);
    expect(state.investments.totalValue).toBe(brk);
  });

  it('a year of spending, computed by the spending engine with verified coverage', () => {
    expect(state.spend.months.length).toBe(13);
    expect(state.spend.coverage.partial).toBe('2026-09');
    expect(state.spend.coverage.completeMonths.length).toBe(12);
    expect(state.spend.rolling.m12).toBeGreaterThan(0);
    // Transfers and card payments are in the ledger and kept out of spending, as in real life.
    expect(state.spend.totals.cardPayment).toBeGreaterThan(0);
    expect(state.spend.totals.investment).toBeGreaterThan(0);
  });

  it('a pace card with something true to say — it finds the one-off purchase by itself', () => {
    const p = state.spend.pace;
    expect(p.status).toBe('ok');
    expect(['above', 'well above']).toContain(p.verdict);
    expect(p.headlineDriver.explain.sentence).toMatch(/one-time Maple & Oak purchase/);
  });

  it('a watchlist the monitor engine actually ran', () => {
    const i = state.inbox;
    expect(i.checksRun).toBe(i.checksTotal);
    expect(i.checksTotal).toBeGreaterThan(0);
    expect(Array.isArray(i.priorities)).toBe(true);
    expect(i.sources.taxFacts).toMatch(/demo has no pay stubs/);
  });

  it('a month of wealth history, explained by the snapshot engine against the ledger', () => {
    const c = state.hist.change;
    expect(state.hist.snapshots).toHaveLength(2);
    expect(c.days).toBe(30);
    // Explained, not a bare residual: the ledger covers the window, so income and spending
    // account for most of it and the market for the rest.
    expect(c.components.map(x => x.key || x.label).length).toBeGreaterThan(0);
    const explained = c.components.filter(x => x.key !== 'netFlow' && !/^Net from/.test(x.label))
      .reduce((t, x) => t + x.amount, 0);
    expect(Math.round(explained + c.residual.amount)).toBe(Math.round(c.delta));
  });

  it('a ledger in date order, so its range is its first and last rows', () => {
    const dates = state.ledger.map(t => t.date);
    expect(dates).toEqual([...dates].sort());
    expect(state.syncStatus.lastDate).toBe('2026-09-23');
  });

  it('two saved cases for the comparison view', () => {
    expect(state.scenarios.map(s => s.name)).toEqual(['Buy two years later', 'A $300K smaller home']);
    expect(state.scenarios[0].params.homePurchaseYear).toBe(P.homePurchaseYear + 2);
  });

  it('an advisor example whose every figure comes off the projection', () => {
    const R = M.run(P).R;
    const [q, a] = Demo.advisorSample(P, R, v => '$' + Math.round(v).toLocaleString('en-US'));
    const r = R.find(x => x.yr === P.kid1Birth);
    expect(q.role).toBe('user');
    expect(a.content).toContain('$' + r.totEFull.toLocaleString('en-US'));
    expect(a.content).toContain('$' + r.hFull.toLocaleString('en-US'));
  });
});

// ── How the page uses it ────────────────────────────────────────────────────
describe('Demo Mode in the page', () => {
  const fn = html.slice(html.indexOf('function enterDemoMode('), html.indexOf('function exitDemoMode'));

  it('starts the owner\'s demo from the scrubbed plan, not the real defaults', () => {
    // It used to be {...D, a dozen overrides}: every other budget line showed the real
    // household while presenting.
    expect(fn).toContain('const base=window.__SHARED_DEMO__?D:PlannerDemo.demoDefaults(D);');
    expect(fn).not.toMatch(/P=\{\.\.\.D,/);
  });

  it('clears what would carry real history into the room', () => {
    for (const s of ['snapshots=[]', 'advisorChats={}', '_briefing=null', '_livePlanParams=null'])
      expect(fn).toContain(s);
  });

  it('fills every server-backed screen from the demo state', () => {
    for (const s of ['_ovw=demo.ovw', '_spend=demo.spend', '_inbox=demo.inbox',
      'monarchInvestments=demo.investments', 'monarchSnapshot=demo.snapshot'])
      expect(fn).toContain(s);
    expect(fn).not.toContain("_ovw={error:");
  });

  it('cannot write a snapshot of the real balances while presenting', () => {
    expect(html).toMatch(/async function takeWealthSnapshot\(\)\{\s*\/\/[^\n]*\n\s*if\(_demoMode\)/);
    expect(fn).toContain('_hist=demo.hist');
  });

  it('shows the advisor example with nothing that can send', () => {
    expect(html).toContain('async function advSend(){\n  if(_demoMode)return;');
    expect(html).toContain('async function advNewChat(){\n  if(_demoMode)');
  });

  it('is loaded by the page and served to demo visitors', () => {
    expect(html).toContain('<script src="/demo-data.js"></script>');
    const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    expect(server).toContain("'pace.js', 'demo-data.js']");
    expect(server).toContain("const Demo = require('./public/demo-data.js');");
  });
});
