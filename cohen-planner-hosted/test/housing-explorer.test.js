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
describe('purchase year is a Home lever, shared with rent-or-buy', () => {
  it('carries the explored year through the same params as rate and down payment', () => {
    // One set of levers: the affordability screen reads the rent-or-buy overrides, so the verdict,
    // the affordable price and the rates grid cannot answer for different assumptions.
    expect(html).toContain('let _afShare=0.25;');
    expect(html).toContain('function afParams(){return rbParams()}');
    expect(html).toContain("if(k==='year')rbSet('homePurchaseYear',v)");
    expect(html).toContain("if(k==='rate')rbSet('mortgageRate',v)");
    expect(html).toContain("else if(k==='down')rbSet('downPctg',v)");
  });

  it('counts an explored year as exploring, so the plan is not silently ahead of the page', () => {
    expect(html).toContain('const exploring=Object.keys(_rbOv).length>0;');
  });

  it('names the year move in the confirmation, and resets together', () => {
    // Moving the purchase year shifts a down payment and every year after it. That is a bigger
    // change than a rate tweak and should not ride along unmentioned.
    const apply = html.slice(html.indexOf('function rbApply('), html.indexOf('function renderHomeTab('));
    expect(apply).toContain('showConfirm(');
    expect(apply).toContain('purchase year');
    expect(html).toContain('function afReset(){_afShare=0.25;rbReset()}');
  });
});

describe('the share lever says what the share is worth', () => {
  it('shows the payment, purchase-year share, limiting year and reserve option',()=>{
    for(const text of ['Comfortable purchase price','% of purchase-year take-home','a.reason','a.year','Use savings at the selected'])expect(tab).toContain(text);
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

  it.each(['brooklyn','deal'])('reconciles the limit against independent annual projections for %s',mode=>{
    const q={...P,homePurchaseYear:2030,locationConfig:{mode,moveYear:2030}};
    const a=M.affordability(q,.25);
    for(const price of [a.max,a.max+1000]){
      const rows=M.run({...q,housingMode:'buy',homePrice:price}).R;
      const end=rows.filter(r=>r.tuFull>0).at(-1).yr;
      const fails=rows.filter(r=>r.liq<q.liquidReserveFloor-1||r.yr>=2030&&r.yr<=end&&(r.hFull>r.netTC*.25||r.totEFull>r.netTC));
      if(price===a.max&&price>0)expect(fails).toHaveLength(0);
      else if(price>a.max)expect(fails.map(r=>r.yr)).toContain(a.year);
    }
  });
  it('counts vested income once, respects savings pins and excludes post-tuition years',()=>{
    const q={planStartYear:2030,homePurchaseYear:2030,housingSavingShare:.10,savingEmergencyY1:15000};
    const base={netTC:100000,incFull:50000,hFull:20000,totEFull:75000,tuFull:0};
    const rows=[{...base,yr:2030},{...base,yr:2031,tuFull:20000,totEFull:90000},{...base,yr:2032,netTC:0}];
    const result=M.housingYears(q,rows,.25);
    expect(result.map(r=>r.margin)).toEqual([5000,-5000]);expect(result[1].gap).toBe(5000);
  });
  it('lets a year be explored by clicking its row', () => {
    expect(tab).toContain('onclick="afSet(\'year\',${v.y})"');
  });

  it('stays inside the plan horizon', () => {
    expect(tab).toContain('Math.min(lastYr,R[0].yr+12)');
  });
});
