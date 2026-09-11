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
    expect(html).toContain("data:[startNwK,...R.map(r=>deflK(r.netWorth,r.yr))]");
    // Routed through one helper now, so a new surface cannot pick the wrong field.
    expect(cockpit).toContain('function cpNw(r){return r?(cockpitExRet?r.nw:r.netWorth):0}');
    expect(cockpit).toContain('...R.map(r=>deflate(cpNw(r),r.yr))');
    // Adding k401 to netWorth would double-count retirement.
    expect(cockpit).not.toMatch(/netWorth\s*\+\s*\w*\.?k401/);
    expect(html).not.toMatch(/netWorth\s*\+\s*\w*\.?k401/);
  });

  it('anchors the total line at the plan opening, not at its cash', () => {
    // The left-hand point used to be startingLiquid alone, dropping Stripe and the whole
    // 401(k), so the first segment showed a jump the model never produced.
    expect(html).toContain("data:[startNwK,...R.map(r=>deflK(r.netWorth,r.yr))]");
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

// `inflationView` is a persisted global toggle. A chart that ignores it is not showing a
// different opinion — it is showing a different unit, with no label saying so.
describe('both charts answer to the same inflation toggle', () => {
  const traj = html;

  it('routes every real-dollar conversion through one function', () => {
    expect(traj).toMatch(/function deflate\(v,yr\)\{if\(!inflationView\)return v;/);
    // deflK is the thousands wrapper, defined in terms of it rather than repeating the math.
    expect(traj).toMatch(/function deflK\(v,yr\)\{return Math\.round\(deflate\(v,yr\)\/1000\)\}/);
  });

  it('has the cockpit deflate its series, not just the Trajectory tab', () => {
    for (const field of ['cpNw(r)', 'r.liq'])
      expect(cockpit, field).toContain(`deflate(${field},r.yr)`);
  });

  it('deflates the cockpit figures printed beside the chart too', () => {
    // A real-dollar line under a nominal headline is the same bug, one element over.
    expect(cockpit).toContain('deflate(cpNw(row),row.yr)');
    expect(cockpit).toContain('deflate(value,row.yr)');
    expect(cockpit).toContain('deflate(cpNw(selected),selected.yr)');
  });

  it('says which dollars it is showing, rather than always claiming future ones', () => {
    expect(cockpit).toContain("inflationView?sy+' purchasing power':'Future dollars'");
  });

  it('anchors the cockpit at the same opening point as the Trajectory tab', () => {
    expect(cockpit).toContain('const labels=[sy-1,...R.map(r=>r.yr)]');
    const open = cockpit.match(/const opening=Math\.round\(([\s\S]*?)\);/)[1];
    for (const part of ['startingLiquid', 'startingStripeEquity', 'k401Start', 'otherDebt'])
      expect(open, part).toContain(part);
  });

  it('leaves the confidence band a hole at the anchor instead of inventing one', () => {
    // There is no simulated percentile for the year before the plan starts.
    expect(cockpit).toContain('data:[null,...band.p90');
    expect(cockpit).toContain('data:[null,...band.p10');
  });
});

// The rule, stated once: a surface showing ONE figure and calling it net worth shows the
// total. A surface showing the component may only do so beside the retirement balance it
// excludes, so the reader can see what is missing. Two screens disagreeing by exactly the
// 401(k) is the signature of this being broken, and it has now happened three times.
describe('every single-figure net worth surface shows the total', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

  it('agrees between the Overview tile and the nav rail', () => {
    // These read $31.62M and $38.06M on the same screen — the tile on `nw`, the rail on the
    // total. The difference was the whole 2058 retirement balance. The tile now follows the
    // same ex-retirement flag the cockpit is on, so the two can differ only by that choice.
    expect(html).toContain('const ovLast=cockpitExRet?last.nw:last.netWorth;');
    expect(html).toContain('money(ovLast)');
    expect(html).toContain('const series=R.map(r=>r.netWorth);');
    expect(html).not.toContain('const series=R.map(r=>r.nw+r.k401);');
  });

  it('quotes the total wherever the advisor is given a net worth', () => {
    expect(server).toContain('finalNW: last.netWorth,');
    expect(html).toContain('${fmt(y58.netWorth)}');
    expect(html).toMatch(/of which 401k/);
  });

  it('measures sensitivity on the total, so a retirement lever is not flattened', () => {
    expect(html).toContain('const baseNW=R[R.length-1].netWorth;');
    expect(html).toContain('const hiNW=hiR[hiR.length-1].netWorth;');
  });

  it('labels the component wherever one is still shown on its own', () => {
    expect(html).toContain("{label:'NW @ 2058 (ex-retirement)'");
    expect(html).toContain("{label:'Net worth @ 2058 (all)'");
  });

  it('leaves the paired KPI cards alone, because they name the exclusion', () => {
    // "Final NW … +$X in 401k" beside "Total w/ 401k" is honest: nothing is hidden.
    expect(html).toContain('in 401k');
    expect(html).toContain('Total w/ 401k');
  });
});

// Three separate code paths could each say "incomplete", and each could say it while naming
// nothing at all.
describe('nothing claims incomplete without naming an account', () => {
  it('will not print a header warning it cannot substantiate', () => {
    expect(html).toContain('const reallyPartial=!!d.partial&&missing>0;');
    expect(html).not.toMatch(/d\.partial\?'Incomplete totals · '/);
    // …and the tooltip that used to read "0 account(s) have no balance".
    expect(html).not.toMatch(/\$\{d\.missingAccounts\.length\} account\(s\) have no balance/);
  });
});

// The same four figures appear on the cockpit and the Overview. If the two screens order
// them differently, the one the reader saw second looks like it changed.
describe('the position tiles keep one order across screens', () => {
  it('puts Stripe before retirement on both', () => {
    const ov = html.indexOf("tile('Stripe equity'");
    const ret = html.indexOf("tile('Retirement'", ov - 400);
    expect(ov, 'overview Stripe tile').toBeGreaterThan(-1);
    expect(ov).toBeLessThan(ret);

    const cpStripe = cockpit.indexOf("metric('Vested Stripe'");
    const cpRet = cockpit.indexOf("metric('Retirement'");
    expect(cpStripe, 'cockpit Stripe metric').toBeGreaterThan(-1);
    expect(cpStripe).toBeLessThan(cpRet);
  });
});

// The Trajectory chart carried seven things competing to answer one question.
describe('the Trajectory chart shows three series', () => {
  const blk = html.slice(html.indexOf("if(_projView==='nw'){"), html.indexOf('if(_stressMode){'));

  it('plots exactly what you can reach, what you own, and the house', () => {
    const labels = [...blk.matchAll(/label:'([^']+)'/g)].map(m => m[1]);
    expect(labels).toEqual(['Net worth ex-retirement', 'Total net worth', 'Home equity']);
  });

  it('has dropped the Monarch pin and the machinery that drew it', () => {
    // The pin read the legacy sync — a different source from the accounts every other figure
    // on the screen comes from — so it marked the chart with a number agreeing with nothing.
    for (const dead of ['_mDotDs', '_mImpliedLiqK', '_mSnap', 'Actual liquid + Stripe', 'startLiqK'])
      expect(html, dead).not.toContain(dead);
  });

  it('overlays a saved scenario as net worth, not as its liquid pool', () => {
    // Plotted on a net-worth chart, a case with more Stripe or a bought house read as worse
    // than the plan drawn over it — two different measures, called a comparison.
    expect(html).toContain("label:s.name+' net worth'");
    expect(html).toContain('s.results.R.map(r=>deflK(r.netWorth,r.yr))');
    expect(html).not.toContain("label:s.name+' Liquid'");
  });
});

// One basis for the whole app: the Overview cannot hold a second opinion about retirement.
describe('the Overview follows the same retirement basis', () => {
  it('reads the cockpit flag rather than always showing the total', () => {
    expect(html).toContain('const ovNw=cockpitExRet?sum.netWorth-ovRet:sum.netWorth;');
    expect(html).toContain('money(ovNw)');
  });

  it('carries the same checkbox, so it can be changed from here', () => {
    const ov = html.slice(html.indexOf('const ovRet='), html.indexOf('Accessible today'));
    expect(ov).toContain('Include retirement');
    expect(ov).toContain('cockpitSetExRet(!this.checked)');
  });

  it('renames the tile when it is narrowed, rather than quietly showing less', () => {
    expect(html).toContain("cockpitExRet?'Net worth ex-retirement':'Net worth'");
    expect(html).toContain('retirement excluded');
    expect(html).toContain('not in net worth above');
  });
});
