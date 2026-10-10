import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import M from '../public/model.js';
import B from '../public/budget.js';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const nj={mode:'deal',moveYear:2031};
describe('location overlay',()=>{
 it('preserves gross pay and Brooklyn years across conservative/base/optimistic incomes',()=>{
  for(const scale of [.85,1,1.15]){
   const p={...D,planEndYear:2045,observedOn:null,normCashY0:D.normCashY0*scale,normStockY0:D.normStockY0*scale};
   const bk=M.run(p).R,n=M.run({...p,locationConfig:nj}).R;
   expect(n.map(r=>r.gross)).toEqual(bk.map(r=>r.gross));
   expect(n.filter(r=>r.yr<2031)).toEqual(bk.filter(r=>r.yr<2031));
   const school=bk.find(r=>r.yr>=2031&&r.tuFull>0),ns=n.find(r=>r.yr===school.yr);
   expect(ns.tuFull).toBeCloseTo(school.tuFull*.5,0);
   expect(ns.taxCity).toBe(0);expect(ns.taxNY).toBeGreaterThan(0);
   for(const r of n){expect(r.totEFull).toBe(r.hFull+Object.values(r.livFullParts).reduce((a,b)=>a+b,0)+r.ccFull+r.tuFull+r.eAdj);expect(Number.isFinite(r.netWorth)).toBe(true);}
   expect(JSON.stringify(p)).not.toContain('locationConfig');
  }
 });
 it('uses the official NJ MFJ schedule, exemptions and credit limits without NYC tax',()=>{
  expect(M.bracketTax(500000,M.NJ_MFJ_BR)).toBeCloseTo(27807.5,2);
  const p={...D,locationConfig:{...nj,moveYear:2026,normNySource:0,nancyNySource:0},housingMode:'rent',nycRent:0,_normW2:750000,_nancyW2:0,_nancySE:0,_nancyOverhead:0,pretax401k:0,pretaxBenefits:0};
  const t=M.calcTax(750000,p,2026,0);
  expect(t.njTaxable).toBe(748000);expect(t.state).toBe(Math.round(M.bracketTax(748000,M.NJ_MFJ_BR)));expect(t.city).toBe(0);expect(t.nySourceTax).toBe(0);
  const cross=M.calcTax(750000,{...p,locationConfig:{...p.locationConfig,normNySource:1}},2026,0);
  expect(cross.njCredit).toBeLessThanOrEqual(cross.njGrossTax);expect(cross.njCredit).toBeLessThanOrEqual(cross.nySourceTax);
  expect(cross.state).toBe(Math.round(cross.nySourceTax+cross.njGrossTax-cross.njCredit));
 });
 it('uses the selected municipality and removes NYC buyer taxes only for NJ purchases',()=>{
  const p={...D,homePurchaseYear:2031,locationConfig:nj};
  expect(M.locationPropertyRate(p,2030)).toBe(D.propTaxRate);
  expect(M.locationPropertyRate(p,2031)).toBe(.00435);
  expect(M.locationPropertyRate({...p,locationConfig:{...nj,municipality:'longBranch'}},2031)).toBe(.0137);
  const cc=M.closingCosts(2000000,p);expect(cc.mansion).toBe(0);expect(cc.recording).toBe(0);
  expect(M.closingCosts(2000000,{...p,homePurchaseYear:2030}).recording).toBeGreaterThan(0);
 });
 it('applies inflation to added car costs, leaves shopping/travel alone, and keeps Deal budget edits exact',()=>{
  const p={...D,locationConfig:nj};
  expect(M.locationSpendingFactor(p,'shopping',2040)).toBe(1);expect(M.locationSpendingFactor(p,'vacations',2040)).toBe(1);
  expect(M.locationAdditions(p,2032).auto/M.locationAdditions(p,2031).auto).toBeCloseTo(1+D.expenseInflation);
  const e=B.edit(p,{category:'groceries',year:2031,scope:'onward',input:{kind:'amount',annual:12000}});
  const changed={...p,...e.pins,budgetRules:e.budgetRules};
  expect(M.run(changed).R.find(r=>r.yr===2031).livFullParts.groceries).toBe(12000);
  expect(M.run({...changed,locationConfig:{mode:'brooklyn'}}).R.find(r=>r.yr===2031).livFullParts.groceries).toBeCloseTo(12000/.95,0);
 });
});
