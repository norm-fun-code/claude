import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const M = require('../public/model.js');

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const cockpit = fs.readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
const room = fs.readFileSync(new URL('../public/decision-room.js', import.meta.url), 'utf8');
const D = vm.runInNewContext('(' + html.match(/const D=(\{[\s\S]*?\n\});/)[1] + ')');

// The engine's `nw` is NOT net worth — it excludes retirement. Every screen that says "net
// worth" therefore has to remember to add k401 back, and for a long time half of them did
// not: the cockpit added it, the Trajectory tab did not, and the same plan read $4.7M apart
// on two screens by 2058. `netWorth` is the total, and these lock the distinction.
describe('what the engine means by net worth', () => {
  const R = M.run(D).R;

  it('keeps nw as a component that genuinely excludes retirement', () => {
    for (const r of R) expect(r.nw, String(r.yr)).toBe(r.netWorth - r.k401);
    expect(R[R.length - 1].k401).toBeGreaterThan(0);   // so the two are really different
  });

  it('reports netWorth as everything the plan models, net of what it owes', () => {
    // Within a dollar per component: liq, sEnd and eq are each rounded before they are
    // shown, so the displayed parts can drift from the displayed total by rounding alone.
    for (const r of R)
      expect(Math.abs(r.netWorth - (r.liq + r.sEnd + r.eq - r.otherDebt + r.k401)), String(r.yr))
        .toBeLessThanOrEqual(3);
  });

  it('sums exactly from the two numbers a reader can see', () => {
    // nw and k401 are both rendered. Adding them must give the total, to the dollar.
    for (const r of R) expect(r.nw + r.k401, String(r.yr)).toBe(r.netWorth);
  });

  it('is a gap large enough to be the bug it was, not a rounding difference', () => {
    const last = R[R.length - 1];
    expect(last.netWorth - last.nw).toBeGreaterThan(1e6);
  });
});

// Both charts plot the same plan from the same engine. They must plot the same field.
describe('the cockpit and the Trajectory tab plot the same figure', () => {
  it('both read netWorth, and neither re-adds retirement on top of it', () => {
    const traj = html.match(/label:'Total NW[^']*'\+\(inflationView\?' \(real\)':''\),data:\[(\w+),\.\.\.R\.map\(r=>deflK\((r\.\w+),r\.yr\)\)\]/);
    expect(traj, 'Total NW dataset').toBeTruthy();
    expect(traj[2]).toBe('r.netWorth');
    expect(cockpit).toContain('data:R.map(r=>r.netWorth)');
    // Adding k401 to netWorth would double-count retirement.
    expect(cockpit).not.toMatch(/netWorth\s*\+\s*\w*\.?k401/);
    expect(html).not.toMatch(/netWorth\s*\+\s*\w*\.?k401/);
  });

  it('anchors the total line at the plan opening, not at its cash', () => {
    // The left-hand point used to be startingLiquid alone, dropping Stripe and the whole
    // 401(k), so the first segment showed a jump the model never produced.
    const [, anchor] = html.match(/label:'Total NW[^']*'\+\(inflationView\?' \(real\)':''\),data:\[(\w+),/);
    expect(anchor).toBe('startNwK');
    const def = html.match(/const startNwK=Math\.round\(\(([^;]+)\)\/1000\)/)[1];
    for (const part of ['startingLiquid', 'startingStripeEquity', 'k401Start', 'otherDebt'])
      expect(def, part).toContain(part);
  });

  it('puts the stress and Monte Carlo bands on the line they bracket', () => {
    // A band drawn on the ex-retirement figure sits permanently below the plan it straddles.
    for (const series of ['Upside NW', 'Downside NW'])
      expect(html, series).toContain(`${series === 'Upside NW' ? 'Upside' : 'Downside'} NW`);
    expect(html).not.toMatch(/data:\[startLiqK,\.\.\.(bull|bear)\.R\.map/);
    for (const p of ['p10', 'p50', 'p90'])
      expect(html, p).not.toMatch(new RegExp(`data:\\[startLiqK,\\.\\.\\.${p}\\.map`));
  });

  it('simulates the same total it draws the band against', () => {
    const src = fs.readFileSync(new URL('../public/model.js', import.meta.url), 'utf8');
    const mc = src.slice(src.indexOf('function runMonteCarlo'));
    expect(mc).toContain('nwPaths.push(R.map(r=>r.netWorth))');
    expect(mc).toContain('finalNW.push(R[R.length-1].netWorth)');
  });

  it('keeps the Decision Room on the same basis as both of them', () => {
    // This chart was once aligned DOWN to the Trajectory tab's ex-retirement figure. The
    // tab was the one in the wrong; aligning to a wrong number is still a mismatch.
    expect(room).toContain('rows.map(r=>decisionDollars(r.netWorth,r.yr))');
    expect(room).not.toContain('Net worth excludes 401k');
  });
});

// A figure presented as "net worth" with no qualifier must be the total. Where a screen
// deliberately shows the component, it has to say so beside the number.
describe('no screen calls the component "net worth" without saying so', () => {
  it('states retirement in the projection hero, which shows the total', () => {
    const at = html.indexOf('hero-eyebrow"><span class="dot"></span>Projected net worth');
    expect(at, 'projection hero').toBeGreaterThan(-1);
    const hero = html.slice(at, html.indexOf('hero-spark', at));
    expect(hero).toContain('fmt(last.netWorth)');
    expect(hero).toContain('retirement');           // named in the composition line
  });

  it('has the advisor quote the total for "Net worth at plan end"', () => {
    const tools = fs.readFileSync(new URL('../public/advisor-tools.js', import.meta.url), 'utf8');
    expect(tools).toContain("finalNetWorth:{label:'Net worth at plan end',pick:r=>r.R[r.R.length-1].netWorth");
  });

  it('still lets the KPI cards show the component, because they label the exclusion', () => {
    // "Final NW … +$X in 401k" next to "Total w/ 401k" is honest: it names what is missing.
    expect(html).toContain('in 401k');
    expect(html).toContain('Total w/ 401k');
  });
});
