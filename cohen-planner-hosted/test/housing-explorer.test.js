import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const M = require('../public/model.js');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const D = vm.runInNewContext('(' + html.match(/const D=(\{[\s\S]*?\n\});/)[1] + ')');
const tab = html.slice(html.indexOf('function renderHousingTab'), html.indexOf('function updateRefiCalc'));

// "How much house can I afford" and "what if I buy later" are the same question asked
// twice. Both now live on the Housing tab, where the first one already was.
describe('purchase year is a housing lever', () => {
  it('carries the explored year through the same params as rate and down payment', () => {
    expect(html).toContain('let _afRate=null,_afDown=null,_afShare=0.28,_afYear=null;');
    expect(html).toMatch(/homePurchaseYear:_afYear\?\?P\.homePurchaseYear/);
    expect(html).toMatch(/else if\(k==='year'\)_afYear=parseInt\(v,10\)/);
  });

  it('counts an explored year as exploring, so the plan is not silently ahead of the page', () => {
    const dirty = html.match(/const dirty=\(_afRate[^;]+;/)[0];
    expect(dirty).toContain('_afYear');
  });

  it('names the year move in the confirmation, and resets it like the others', () => {
    // Moving the purchase year shifts a down payment and every year after it. That is a
    // bigger change than a rate tweak and should not ride along unmentioned.
    expect(html).toContain('move your purchase to ${q.homePurchaseYear}');
    expect(html).toContain('P.homePurchaseYear=q.homePurchaseYear;');
    expect(html).toContain('_afRate=null;_afDown=null;_afYear=null;');
    expect(html).toContain("function afReset(){_afRate=null;_afDown=null;_afYear=null;_afShare=0.28;render()}");
  });
});

describe('the share lever says what the share is worth', () => {
  it('shows the budget in dollars, not only a percentage', () => {
    // A percentage is not a budget until it is a number of dollars.
    expect(tab).toContain('const shareBudget=_afShare*buyRow.netTC;');
    expect(tab).toContain('fmtF(Math.round(shareBudget/12))');
    expect(tab).toMatch(/\$\{fmt\(Math\.round\(shareBudget\)\)\}\/yr/);
  });

  it('names the year and the income the share is a share OF', () => {
    expect(tab).toMatch(/after-tax income in \$\{py\}/);
  });

  it('recomputes on every move, because afSet re-renders the tab', () => {
    expect(html).toMatch(/function afSet\(k,v\)\{[\s\S]*?render\(\);\n\}/);
  });
});

describe('what waiting actually buys', () => {
  const share = 0.28;
  const P = { ...D, observedOn: '2026-09-11' };
  const by = y => M.affordability({ ...P, homePurchaseYear: y }, share);

  it('re-runs the whole model per year rather than growing one number', () => {
    expect(tab).toContain('const af=affordability(py2,_afShare);');
    expect(tab).toContain('homePurchaseYear:y');
  });

  it('reports which limit binds, and the binding one really does change with time', () => {
    // Early on the balance sheet binds — there is not enough saved yet. Later, income is
    // the constraint. Showing the max without saying which is a number with no lever.
    expect(by(2026).binding).toBe('plan');
    expect(by(2035).binding).toBe('comfort');
    expect(tab).toContain("v.binding==='comfort'?'Carrying cost':'Balance sheet'");
  });

  it('is monotone while the balance sheet binds, because saving only accumulates', () => {
    for (let y = 2026; y < 2029; y++)
      expect(by(y + 1).max, String(y)).toBeGreaterThan(by(y).max);
  });

  it('lets a year be explored by clicking its row', () => {
    expect(tab).toContain('onclick="afSet(\'year\',${v.y})"');
  });

  it('stays inside the plan horizon', () => {
    expect(tab).toContain('Math.min(lastYr,R[0].yr+12)');
  });
});
