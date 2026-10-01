import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const S=require('../public/income-share.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const R=M.run({...D,planStartYear:2026,observedOn:null}).R;
const at=y=>R.find(r=>r.yr===y);

describe('where a year\'s income goes',()=>{
 it('accounts for every dollar of income, in both bases, in every year',()=>{
  for(const r of R)for(const b of ['gross','net']){
   const c=S.compute(r,b);
   expect(c.accounted).toBe(c.denom);
   expect(c.segments.reduce((t,s)=>t+(s.key==='short'?-s.value:s.value),0)).toBe(c.denom-(b==='gross'?0:0)-(0));
  }
 });
 it('the tiers add to the year\'s expenses exactly, as the Trajectory table shows them',()=>{
  for(const r of R){
   const c=S.compute(r,'gross');
   expect(c.tiers.reduce((t,x)=>t+x.value,0)+c.oneOff).toBe(r.totEFull);
   expect(c.spend).toBe(r.totEFull);
  }
 });
 it('takes tax and pre-tax deductions out of gross, and not out of after-tax',()=>{
  const g=S.compute(at(2035),'gross'),n=S.compute(at(2035),'net');
  expect(g.segments.map(s=>s.key)).toEqual(expect.arrayContaining(['tax','pretax']));
  expect(n.segments.map(s=>s.key)).not.toContain('tax');
  expect(g.denom).toBe(at(2035).gross);expect(n.denom).toBe(at(2035).netTC);
  expect(g.tax).toBe(at(2035).tax);
 });
 it('classifies lines by one written rule, and an unknown line is not lost',()=>{
  const c=S.compute(at(2035),'gross');
  const lines=t=>c.tiers.find(x=>x.key===t).lines.map(l=>l.key);
  expect(lines('fixed')).toEqual(expect.arrayContaining(['housing','tuition','childcare','insurance','utilities','transit','auto']));
  expect(lines('essential').sort()).toEqual(['groceries','medical']);
  expect(lines('choice')).toEqual(expect.arrayContaining(['dining','shopping','clothing','vacations','entertainment','charity','misc']));
  const extra=S.compute({...at(2035),livFullParts:{...at(2035).livFullParts,pets:500},eAdj:0,totEFull:at(2035).totEFull-at(2035).eAdj+500},'gross');
  expect(extra.tiers.find(x=>x.key==='choice').lines.some(l=>l.key==='pets')).toBe(true);
  expect(extra.accounted).toBe(extra.denom);
 });
 it('says "beyond income" rather than a negative share when spending exceeds income',()=>{
  const r=R.find(r=>r.netTC-r.totEFull<0);
  expect(r).toBeTruthy();
  const c=S.compute(r,'net');
  expect(c.overspent).toBe(true);
  expect(c.segments.at(-1)).toMatchObject({key:'short'});
  expect(c.segments.every(s=>s.value>=0||s.key==='oneoff')).toBe(true);
  expect(c.accounted).toBe(c.denom);
 });
 it('a one-off is its own line, not folded into fixed or discretionary',()=>{
  const r=M.run({...D,planStartYear:2026,observedOn:null,expenseAdjY9:40000}).R.find(r=>r.yr===2035);
  const c=S.compute(r,'gross');
  expect(c.oneOff).toBe(40000);
  expect(c.segments.find(s=>s.key==='oneoff').value).toBe(40000);
  expect(c.accounted).toBe(c.denom);
 });
 it('returns nothing, not NaN, when there is no income',()=>{
  expect(S.compute({...at(2035),gross:0,netTC:0},'gross')).toBe(null);
  expect(S.compute(null,'gross')).toBe(null);
 });
 it('is on the Spending tab, served, and reads the plan rather than the ledger',()=>{
  expect(html).toContain('<script src="/income-share.js"></script>');
  expect(server).toContain("'income-share.js'");
  expect(html).toContain('h+=renderPlanShareCard(R);');
  const fn=html.slice(html.indexOf('function renderPlanShareCard('),html.indexOf('function renderSpendingTab('));
  expect(fn).not.toMatch(/_spend\b|loadSpending/);
  expect(fn).toContain('Year to look at');
 });
});

describe('a share of income beside every expense figure',()=>{
 const fn=html.slice(html.indexOf('function expDetailRow('),html.indexOf('function expAdjSet('));
 it('defaults to net income, shares the look-ahead card\'s setting, and divides the full-year figures',()=>{
  expect(html).toContain("let _planShareYear=null,_planShareBasis='net',");
  expect(fn).toContain("den=gross?r.gross:r.netTC");
  expect(fn).toContain('onclick="planShareBasis(');
  expect(fn).toMatch(/exp-pct/);expect(fn).toMatch(/exp-share/);
 });
 it('a living line over net income is the figure the card would report',()=>{
  const r=at(2035),c=S.compute(r,'net'),g=c.tiers.flatMap(t=>t.lines).find(l=>l.key==='groceries');
  expect((r.livFullParts.groceries/r.netTC*100).toFixed(1)).toBe((g.share*100).toFixed(1));
 });
});

describe('categories against income',()=>{
 it('takes a twelfth of each month\'s year, and the part-month share of the month in progress',()=>{
  const r26=at(2026),r27=at(2027);
  const full=S.periodIncome([{month:'2026-11'},{month:'2026-12'},{month:'2027-01'}],R,{});
  expect(full.ok).toBe(true);
  expect(full.gross).toBeCloseTo(r26.gross/12*2+r27.gross/12,6);
  expect(full.net).toBeCloseTo(r26.netTC/12*2+r27.netTC/12,6);
  const part=S.periodIncome([{month:'2026-11'},{month:'2026-12'}],R,{partial:'2026-12',fraction:.5});
  expect(part.weight).toBeCloseTo(1.5,9);
  expect(part.gross).toBeCloseTo(r26.gross/12*1.5,6);
 });
 it('refuses to guess income for a month the plan does not cover',()=>{
  expect(S.periodIncome([{month:'2024-05'}],R,{}).ok).toBe(false);
  expect(S.periodIncome([],R,{}).ok).toBe(false);
 });
 it('sits between the charts and the look-ahead card, defaults to net, and hides what it cannot compute',()=>{
  const spend=html.slice(html.indexOf('function renderSpendingTab('));
  expect(html).toContain("let _catLensBasis='net';");
  expect(spend.indexOf('h+=renderCategoryLens(')).toBeGreaterThan(spend.indexOf('class="spend-visuals"'));
  // Also rendered in the two early-return branches (no history, or an error), so the plan view
  // is there without imports; the one that matters for order is the last.
  expect(spend.match(/h\+=renderPlanShareCard\(R\);/g).length).toBe(3);
  const last=spend.lastIndexOf('h+=renderPlanShareCard(R);');
  expect(last).toBeGreaterThan(spend.indexOf('h+=renderCategoryLens('));
  expect(last).toBeLessThan(spend.indexOf('Category details'));
  const lens=html.slice(html.indexOf('function renderCategoryLens('),html.indexOf('function renderSpendingTab('));
  expect(lens).toContain("const basis=have?_catLensBasis:'spend';");
 });
});
