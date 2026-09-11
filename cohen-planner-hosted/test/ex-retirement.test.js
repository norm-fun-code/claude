import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const M = require('../public/model.js');
const B = require('../public/bridge.js');
const A = require('../public/accounts.js');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const cockpit = fs.readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
const D = vm.runInNewContext('(' + html.match(/const D=(\{[\s\S]*?\n\});/)[1] + ')');

const accounts = [
  { id: '1', name: 'Chase Checking', category: 'cash', balance: 180000 },
  { id: '2', name: 'Fidelity Brokerage', category: 'investment', balance: 520000 },
  { id: '3', name: 'Stripe Equity', category: 'other_asset', balance: 614000 },
  { id: '4', name: 'Stripe 401(k)', category: 'retirement', balance: 240000 },
  { id: '5', name: 'Amex', category: 'liability', balance: -9000 },
];
const row = o => ({ ...o, netWorth: o.nw + o.k401 });
const R = [row({ yr: 2026, nw: 1180000, k401: 230000, liq: 900000, sEnd: 280000, eq: 0 })];
const P = { startingLiquid: 1100000, startingStripeEquity: 0, k401Start: 210000 };
const br = ex => B.bridge({ summary: A.summarize(accounts, {}), R, P, year: 2026,
  accountsAvailable: true, exRetirement: ex });

// Retirement is wealth you cannot reach for decades, and a 401(k) that dwarfs everything else
// drowns out the question "what can I actually get at". The cockpit can exclude it — but a
// page showing one figure ex-retirement beside another including it is the exact defect this
// cockpit spent a long time removing, so the switch has to move everything at once.
describe('every cockpit figure switches together', () => {
  it('routes the whole cockpit through a single accessor', () => {
    expect(cockpit).toContain('function cpNw(r){return r?(cockpitExRet?r.nw:r.netWorth):0}');
    // No surface may reach past it for the raw field.
    const body = cockpit.slice(cockpit.indexOf('function renderCockpit'));
    expect(body).not.toMatch(/\br\.netWorth\b/);
    expect(body).not.toMatch(/\b(row|selected|current)\.netWorth\b/);
  });

  it('excludes retirement from the OBSERVED side too, not just the projection', () => {
    // Excluding it from one side only would compare a figure without retirement against one
    // with it — a mismatch of exactly the 401(k).
    expect(cockpit).toContain('const obsNw=available?(cockpitExRet?s.netWorth-obsRetirement:s.netWorth):null;');
  });

  it('drops the 401(k) from the chart anchor as well as the line', () => {
    expect(cockpit).toContain('cockpitExRet?opening-Math.abs(Number(P.k401Start||0)):opening');
  });

  it('is a checkbox, whose on/off meaning lives in the control rather than the caption', () => {
    // A button captioned "Including retirement" reads equally well as the thing it will do.
    // A checkbox cannot be misread that way: ticked is included, and the line beneath says
    // which side of it you are currently on.
    expect(cockpit).toContain('type="checkbox" id="cp-inc-ret"');
    expect(cockpit).toContain('Include retirement');
    expect(cockpit).toContain('onchange="cockpitSetExRet(!this.checked)"');
    // Ticked when retirement is IN, which is the opposite of the flag it drives.
    expect(cockpit).toContain("${cockpitExRet?'':' checked'}");
    expect(cockpit).toContain("cockpitExRet?'Excludes retirement':'Includes retirement'");
    expect(cockpit).toMatch(/NET WORTH\$\{cockpitExRet\?' · EX-RETIREMENT':''\}/);
  });

  it('starts unticked, because the default is what you can actually reach', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(html).toMatch(/let cockpitExRet=true;/);   // true = excluding = box unticked
  });

  it('leads with what can actually be reached, which is what was asked for', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(html).toMatch(/let cockpitExRet=true;/);
  });

  it('does not let the old auto-saved default override the new one', () => {
    // The boolean was written on every save while it still defaulted the other way, so a
    // stored `false` records the old default rather than anyone's decision. A new key means
    // only a real choice is ever read back.
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(html).toContain("cockpitNwBasis:cockpitExRet?'exRetirement':'total'");
    expect(html).toContain("if(s.cockpitNwBasis!==undefined)cockpitExRet=s.cockpitNwBasis!=='total';");
    expect(html).not.toContain('if(s.cockpitExRet!==undefined)');
  });

  it('marks the retirement tile as sitting outside the headline', () => {
    expect(cockpit).toContain('NOT in the figure above');
  });

  it('persists the choice with the rest of the view state', () => {
    expect(html).toContain("cockpitNwBasis:cockpitExRet?'exRetirement':'total',activeScenarioIdx");
  });
});

describe('the confidence band follows the basis', () => {
  const mc = M.runMonteCarlo({ ...D, observedOn: '2026-09-11' }, 30);

  it('produces both bases from the same trials', () => {
    // A band drawn against one line must come from the trials that produced it. Re-simulating
    // would give a band that disagrees with its own line for reasons nobody could find.
    expect(mc.band.p50.length).toBe(mc.bandExRet.p50.length);
    for (let i = 0; i < mc.band.p50.length; i++)
      expect(mc.bandExRet.p50[i], String(i)).toBeLessThan(mc.band.p50[i]);
  });

  it('switches without re-running the simulation', () => {
    expect(cockpit).toContain("_cpBand={total:mc.band,exRet:mc.bandExRet}");
    expect(cockpit).toContain('cockpitExRet?_cpBand.exRet:_cpBand.total');
    const toggle = cockpit.slice(cockpit.indexOf('function cockpitSetExRet'), cockpit.indexOf('function cockpitGo'));
    expect(toggle).not.toContain('_cpBandSig');
  });
});

describe('the reconciliation follows the basis', () => {
  it('still closes exactly when retirement is excluded', () => {
    // If the bridge dropped retirement from one side only it would fail to close by exactly
    // the 401(k) — the very error it exists to expose.
    for (const ex of [false, true]) {
      const b = br(ex);
      const walked = b.lines.reduce((n, l) => n + (l.value == null ? 0 : l.value), 0);
      expect(b.observed + walked, String(ex)).toBe(b.projected);
    }
  });

  it('is lower on both ends by exactly the retirement balance', () => {
    const inc = br(false), ex = br(true);
    expect(inc.observed - ex.observed).toBe(240000);       // the observed 401(k)
    expect(inc.projected - ex.projected).toBe(R[0].k401);  // the projected one
    expect(inc.opening - ex.opening).toBe(P.k401Start);
  });

  it('names what it left out, rather than quietly showing a smaller number', () => {
    const b = br(true);
    expect(b.lines[0].label).toMatch(/outside retirement/);
    expect(b.lines[0].note).toMatch(/\$240,000/);
    expect(b.lines.at(-1).label).toMatch(/ex-retirement/);
  });

  it('drops exactly the retirement share of the plan gap, and no more', () => {
    // Retirement does NOT simply cancel: the observed 401(k) and the plan's k401Start are
    // two different numbers, and that difference is itself part of what makes the plan
    // stale. Excluding retirement removes precisely that much of the gap — so the remaining
    // gap is the disagreement about everything you can actually reach.
    const inc = br(false), ex = br(true);
    const retMismatch = 240000 - P.k401Start;
    expect(inc.planGap - ex.planGap).toBe(retMismatch);
    expect(ex.planGap).toBe(205000);
  });

  it('defaults to including retirement when nothing is passed', () => {
    const b = B.bridge({ summary: A.summarize(accounts, {}), R, P, year: 2026, accountsAvailable: true });
    expect(b.projected).toBe(br(false).projected);
  });
});
