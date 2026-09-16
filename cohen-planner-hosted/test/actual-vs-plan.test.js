import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const M = require('../public/model.js');

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const D = vm.runInNewContext('(' + html.match(/const D=(\{[\s\S]*?\n\});/)[1] + ')');
const plan = (over) => ({ ...D, planStartYear: 2026, ...over });

// ── A whole year on every row ───────────────────────────────────────────────
// The engine opens partway through the first year on purpose: the months before the
// observation date are already inside the opening balances and compounding them again is how
// a September position projected a $280K gain by New Year. But the TABLE is a comparison, and
// a quarter of 2026 set beside all of 2027 answers nothing about either.
describe('the whole-year counterparts the table reads', () => {
  it('equal the modelled figures exactly on a plan with no stub, in every year', () => {
    // The substitution that produces them is only right if it collapses to the same thing
    // when there is nothing to scale. This is that check.
    for (const r of M.run(plan({ observedOn: null })).R) {
      expect(r.incFull).toBe(r.inc);
      expect(r.flowFull).toBe(r.flow);
      expect(r.gapFull).toBe(r.gap);
      expect(r.totEFull).toBe(r.totE);
    }
  });

  it('are larger than the modelled figures in the stub year, and equal after it', () => {
    const R = M.run(plan({ observedOn: '2026-09-16' })).R;
    expect(R[0].stubFrac).toBeLessThan(1);
    expect(R[0].incFull).toBeGreaterThan(R[0].inc);
    expect(R[0].totEFull).toBeGreaterThan(R[0].totE);
    expect(R[0].flowFull).toBeGreaterThan(R[0].flow);
    for (const r of R.slice(1)) {
      expect(r.incFull).toBe(r.inc);
      expect(r.flowFull).toBe(r.flow);
    }
  });

  it('do not touch what the projection carries forward', () => {
    // The stub is the whole reason the balances are right. Only the reported figures change.
    const a = M.run(plan({ observedOn: '2026-09-16' })).R;
    const src = fs.readFileSync(new URL('../public/model.js', import.meta.url), 'utf8');
    expect(a[0].liq).toBeGreaterThan(0);
    // liq/stripeEnd/k401 are still driven by the stub-scaled flow, not the full-year one.
    expect(src).not.toMatch(/liq=.*flowFull/);
    expect(src).toContain('const flowFull=tax.net-totEFull;');
  });
});

// ── Checking the year you are standing in ───────────────────────────────────
describe('actual so far, against the plan for the same stretch', () => {
  it('compares like with like rather than a part year against a whole one', () => {
    // Spending-to-date measured against a full year would report every household on earth as
    // comfortably under budget in January.
    expect(html).toContain('const planToDate=plan*share;');
    expect(html).toContain('const share=a.elapsed/12;');
  });

  it('counts the month in progress for the part of it that has passed', () => {
    // "So far" means so far: eight closed months plus half of September is 8.5, not 8 and
    // not 9.
    expect(html).toContain("const elapsed=closed.length+(rows.length>closed.length?(Number((d.coverage||{}).fractionElapsed)||0):0);");
    expect(html).toContain('const spent=rows.reduce((t,m)=>t+(Number(m.expense)||0),0);');
  });

  it('only appears for the year we are actually in', () => {
    expect(html).toContain("if(year!==new Date().getFullYear())return null;");
  });

  it('asks for the ledger when the row is opened, since this tab never loaded it', () => {
    expect(html).toContain("if(_expOpenYears.has(yr)&&yr===new Date().getFullYear()&&!_spend&&!_spendLoading)loadSpending();");
    expect(html).toContain("if(_spendLoading)return{loading:true};");
  });

  it('says nothing rather than guessing when there is no ledger to read', () => {
    expect(html).toContain("if(!d||d.error||!Array.isArray(d.months))return null;");
    expect(html).toContain("if(!rows.length)return null;");
    expect(html).toContain("if(!a)return '';");
  });

  it('admits the two taxonomies are not the same, instead of matching lines that do not', () => {
    expect(html).toMatch(/different taxonomies, so this compares totals, not lines/);
    expect(html).toMatch(/net of refunds, with transfers and card payments excluded/);
  });

  it('calls a small difference "on plan" rather than dressing noise as a finding', () => {
    expect(html).toContain("Math.abs(diff)<Math.max(1000,planToDate*0.03)");
  });
});

describe('the CSV keeps both, because it is the audit export', () => {
  it('carries the modelled figures and the full-year ones, and says which is which', () => {
    for (const c of ['Modeled Fraction Of Year', 'Cash Available (modeled)', 'Cash Available (full year)',
      'Total Expenses (modeled)', 'Total Expenses (full year)', 'Net Flow (modeled)',
      'Net Flow (full year)', 'Cash Gap (full year)'])
      expect(html).toContain(`'${c}'`);
  });

  it('has exactly as many values as it has columns', () => {
    const i = html.indexOf("const cols=['Year','Norm Cash'");
    const cols = html.slice(i, html.indexOf('];', i)).match(/'[^']*'/g).length;
    const j = html.indexOf('const rows=R.map(r=>[', i);
    const vals = html.slice(j, html.indexOf(']);', j)).split(',').length;
    expect(vals).toBe(cols);
  });
});

describe('the breakdown answers in the same period as the figure it opened from', () => {
  it('carries full-year components, and they sum to the full-year total', () => {
    // Opening a $171K cell and being shown $50K of parts is a contradiction, not a detail.
    for (const obs of [null, '2026-09-16'])
      for (const r of M.run(plan({ observedOn: obs })).R) {
        const liv = M.LIV_KEYS.reduce((s, k) => s + r.livFullParts[k], 0);
        expect(r.hFull + liv + r.ccFull + r.tuFull + r.eAdj).toBe(r.totEFull);
      }
  });

  it('reads the full-year parts in the detail row', () => {
    expect(html).toContain("const lp=r.livFullParts||r.livParts||{};");
    expect(html).toContain("${part('Housing',r.hFull,");
    expect(html).toContain("${part('Total',r.totEFull,");
    // The living heading is summed from the same twelve lines printed beneath it.
    expect(html).toContain('const livTotal=keys.reduce((t,k)=>t+(lp[k]||0),0);');
    expect(html).toContain('Inside living · ${fmt(livTotal)}, largest first');
  });
});
