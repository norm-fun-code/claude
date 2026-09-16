import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const M = require('../public/model.js');
const B = require('../public/bridge.js');
const { createHoldingsBridge } = require('../holdings-bridge.js');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const cockpit = fs.readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
const D = vm.runInNewContext('(' + html.match(/const D=(\{[\s\S]*?\n\});/)[1] + ')');

const plan = (over = {}) => ({ ...D, planStartYear: 2026, planEndYear: 2030, observedOn: null,
  homePurchaseYear: 2099, startingLiquid: 619786, startingStripeEquity: 623000,
  k401Start: 297000, otherDebt: 0, otherAssets: 51500, ...over });

// ── The bridge's per-pool breakdown ──────────────────────────────────────
// It renders only when its parts sum EXACTLY to the year's change. A pool added to the model
// without a matching row does not produce a wrong line — it silently removes the whole
// breakdown, which is the failure mode model.js warns about at the `nw` rounding comment.
describe('the bridge accounts for every pool the model carries', () => {
  const P = plan();
  const R = M.run(P).R;
  const summary = { netWorth: 619786 + 623000 + 51500 + 297000, accessible: 619786,
    stripeVested: 623000, complete: true, byClass: { retirement: { total: 297000, accounts: [{}] } } };

  it('has a line for private assets, and the parts still sum to the year', () => {
    const opening = B.openingPosition(R, 2026, P, true);
    const parts = B.yearParts(R[0], opening, true);
    expect(parts.map(p => p.key)).toContain('other');
    // The exact condition the UI gates the breakdown on.
    const partsSum = parts.reduce((n, p) => n + p.value, 0);
    expect(partsSum).toBe(R[0].nw - opening.value);
  });

  it('would have lost the breakdown entirely without that line', () => {
    // Not a wrong figure — a missing section. Proving the gap is real, not theoretical.
    const opening = B.openingPosition(R, 2026, P, true);
    const without = B.yearParts(R[0], opening, true).filter(p => p.key !== 'other');
    expect(without.reduce((n, p) => n + p.value, 0)).not.toBe(R[0].nw - opening.value);
  });

  it('splices retirement by name, so a new pool cannot displace it', () => {
    const src = fs.readFileSync(new URL('../public/bridge.js', import.meta.url), 'utf8');
    expect(src).toContain("out.findIndex(p=>p.key==='debt')");
    expect(src).not.toContain('out.splice(3,0');
  });
});

// ── Anchors that must carry every pool ───────────────────────────────────
describe('every opening anchor carries the same pools as the engine', () => {
  it('the story walkthrough anchor includes private assets', () => {
    // R[].nwExRetHome includes otherAssets, so an anchor that omits it invents a jump into
    // year one that the model never produced.
    const anchor = html.slice(html.indexOf('.map(m=>({...m,row:m.yr===sy'), html.indexOf('.map(m=>({...m,row:m.yr===sy') + 400);
    expect(anchor).toContain('Math.max(0,Number(P.otherAssets)||0)');
  });

  it('the snapshot overlay finds the anchor by position, not by parsing its label', () => {
    // The anchor's label is a date now ("Sep 16"); parseInt returned NaN and dropped the point.
    expect(html).toContain("const snData=nwLabels.map((lbl,i)=>{const v=i===0?byYr[snSy-1]");
  });
});

// ── Figures that must not go stale under the reader ──────────────────────
describe('the path-ahead delta moves with the year scrub', () => {
  it('is rebuilt, not left behind', () => {
    // It sits beside #cp-value, which the scrub rewrites; left alone it reported 2026's
    // change under 2041's figure.
    const fn = cockpit.slice(cockpit.indexOf('function cockpitSelectYear'), cockpit.indexOf('function cockpitRenderYearEnd'));
    expect(fn).toContain("document.querySelector('.cp-delta')");
    expect(fn).toContain('cockpitDelta(');
  });
});

describe('claims the data does not support', () => {
  it('only calls a period figure a return when the payload says so', () => {
    // The server shaping that set periodMetric went with the Monarch client; absent must mean
    // unknown, not "contribution-aware return".
    expect(html).toContain("const periodIsReturn=inv.periodMetric==='return';");
  });

  it('does not report a portfolio worth nothing when the total is simply absent', () => {
    expect(html).toContain('(inv.holdings||[]).reduce((a,h)=>a+(Number(h.value)||0),0)');
  });

  it('does not date the balances from a failed read', () => {
    // An _ovw error object has no asOf; falling through to the legacy sync painted a green
    // "Balances read today" over a read that failed.
    expect(html).toContain('const balanceDate=(_ovw&&!_ovw.error&&_ovw.asOf)||monarchSnapshot?.syncedAt;');
  });
});

// ── The roll-forward's one guarantee ─────────────────────────────────────
describe('rolling the year forward', () => {
  it('promises the year it can actually reach', () => {
    // rollForwardParams advances exactly one year; the button said "to {currentYear}".
    expect(cockpit).toContain('Roll forward to ${due.closingYear+1}');
    expect(cockpit).not.toContain('Roll forward to ${due.currentYear}');
  });

  it('refuses to advance on a snapshot that did not save', () => {
    // saveSnapshot() used to swallow its transport error, so awaiting it proved nothing —
    // and rolling forward rewrites the projection the closing year is scored against.
    expect(html).toContain('return ok;');
    expect(cockpit).toContain('if(await saveSnapshot(true,label)!==true)throw new Error');
  });
});

// ── One upstream request, not one per page load ──────────────────────────
describe('the holdings bridge', () => {
  const make = (counter) => createHoldingsBridge({
    db: { query: async () => ({ rows: [{ data: {} }] }) },
    env: { NORMOS_URL: 'https://normos.example.com', PLANNER_BRIDGE_TOKEN: 't' },
    fetchImpl: async () => { counter.n++; return { ok: true, status: 200,
      json: async () => ({ holdings: [{ ticker: 'VOO', value: 100 }], asOf: new Date().toISOString() }) }; },
  });

  it('coalesces concurrent callers into one upstream request', async () => {
    const c = { n: 0 }, h = make(c);
    await Promise.all([h('1M'), h('1M'), h('1M')]);
    expect(c.n).toBe(1);
  });

  it('serves the window NormOS itself honours, instead of re-asking every page load', async () => {
    // The overview endpoint abandons this call at 1.5s while the bridge allows 60s; uncached,
    // that paid for an upstream read on every load and threw the answer away.
    const c = { n: 0 }, h = make(c);
    await h('1M'); await h('1M'); await h('1M');
    expect(c.n).toBe(1);
  });

  it('keeps periods apart', async () => {
    const c = { n: 0 }, h = make(c);
    await h('1M'); await h('3M');
    expect(c.n).toBe(2);
  });
});
