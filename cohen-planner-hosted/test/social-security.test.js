import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import S from '../public/social-security.js';
import F from '../public/financial-independence.js';
import M from '../public/model.js';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const p={...D,observedOn:null,normManualThroughYear:2037};
const analyze=(c={},q=p)=>F.analyze(q,c,M,{scan:false,stresses:false});
const at=(a,y)=>a.result.R.find(r=>r.yr===y);
describe('SSA retirement method and benefit coordination',()=>{
 it('reproduces the 2026 bend-point formula for a $6,000 AIME with 35 indexed years',()=>{
  const h={};for(let y=1991;y<=2025;y++)h[y]=y<2024?72000*S.AWI[y]/S.AWI[2024]:72000;
  const x=S.pia(h,1964,2026,0,0);expect(x.aime).toBe(6000);expect(x.pia).toBe(2665.8);
 });
 it('zero-fills missing years and requires 40 quarters; it never invents earnings',()=>{
  expect(S.pia({},1964,2026).pia).toBe(0);
  const h={};for(let y=2017;y<=2025;y++)h[y]=100000;expect(S.pia(h,1964,2026).pia).toBe(0);
  h[2016]=100000;expect(S.pia(h,1964,2026).pia).toBeGreaterThan(0);
  expect(S.pia({...h,2027:1e9},1964,2026)).toEqual(S.pia(h,1964,2026));
 });
 it('uses exact early / delayed claiming factors and spousal early reductions',()=>{
  expect(S.claimFactor(62)).toBeCloseTo(.7,10);expect(S.claimFactor(67)).toBe(1);expect(S.claimFactor(70)).toBeCloseTo(1.24,10);
  expect(S.spouseFactor(62)).toBeCloseTo(.65,10);expect(S.claimFactor(62,67,60)).toBe(1);
 });
 it('pays only the spousal excess and replaces, rather than adds, survivor benefits',()=>{
  const q={...p,planStartYear:2060,expenseInflation:0},c=F.config(q,{nancyBirthYear:1993,normSSMonthly:3000,nancySSMonthly:1000,ssCola:0,normDeathAge:70});
  const e=S.create(q,c);let r=e.step(2060,0,0);expect(r.norm).toBe(36000);expect(r.nancy).toBe(18000);
  e.step(2061,0,0);e.step(2062,0,0);r=e.step(2063,0,0);expect(r.norm).toBe(0);expect(r.nancy).toBe(36000);
 });
 it('defers spousal excess until the worker claims and does not apply delayed credits to that excess',()=>{
  const q={...p,planStartYear:2060,expenseInflation:0},c=F.config(q,{nancyBirthYear:1993,normSSMonthly:3000,nancySSMonthly:1000,ssCola:0,normClaimAge:70,nancyClaimAge:70});
  const e=S.create(q,c);expect(e.step(2060,0,0).total).toBe(0);
  const r=e.step(2063,0,0);expect(r.norm).toBe(44640);expect(r.nancy).toBe(20880);
 });
 it('applies earnings withholding only before FRA and restores withheld-month credits at FRA',()=>{
  const q={...p,planStartYear:2055,expenseInflation:0},c=F.config(q,{normSSMonthly:3000,nancySSMonthly:0,normClaimAge:62,ssCola:0});
  const e=S.create(q,c);for(let y=2055;y<2060;y++){const r=e.step(y,1e6,0,1e6,0);expect(r.norm).toBe(0);expect(r.withheld).toBeGreaterThan(0);}
  expect(e.step(2060,1e6,0,1e6,0).norm).toBe(36000);
 });
 it('benefit sensitivity scales payments exactly without changing claiming or earnings-test credits',()=>{
  const q={...p,planStartYear:2055,expenseInflation:0};
  const full=S.create(q,F.config(q,{normSSMonthly:3000,normClaimAge:62,ssCola:0}));
  const reduced=S.create(q,F.config(q,{normSSMonthly:3000,normClaimAge:62,ssCola:0,ssLevel:.75}));
  for(let y=2055;y<=2065;y++){const x=full.step(y,1e5,0,1e5,0),z=reduced.step(y,1e5,0,1e5,0);expect(z.total).toBeCloseTo(.75*x.total,6);}
 });
 it('uses federal provisional-income thresholds with a maximum 85% taxable, not an 85% tax',()=>{
  expect(S.taxable(20000,0)).toBe(0);expect(S.taxable(20000,30000)).toBe(4000);
  expect(S.taxable(20000,100000)).toBe(17000);expect(S.taxable(20000,25000,true)).toBeCloseTo(5350);
 });
});
describe('Social Security and later earnings use the shared financial engine',()=>{
 it('keeps the original scenario unchanged and benefits change when transition earnings change',()=>{
  const before=JSON.stringify(p),a=analyze(),low=analyze({normIncome:0,nancyIncome:0});
  expect(JSON.stringify(p)).toBe(before);expect(M.run({...p,fiConfig:{enabled:false}})).toEqual(M.run(p));
  expect(at(a,2060).fiSSNorm).toBeGreaterThan(at(low,2060).fiSSNorm);
  expect(at(a,2065).fiSSNancy).toBeGreaterThan(at(low,2065).fiSSNancy);
  const earlier=analyze({transitionYear:2028,normGrowth:0}),later=analyze({transitionYear:2034,normGrowth:0});expect(at(earlier,2060).fiSSNorm).toBeLessThan(at(later,2060).fiSSNorm);
 });
 it('keeps SS separate from earned income and uses each spouse’s claiming age',()=>{
  const a=analyze({normClaimAge:62,nancyClaimAge:70,normStopAge:60});
  expect(at(a,2054).fiSSNorm).toBe(0);expect(at(a,2055).fiSSNorm).toBeGreaterThan(0);
  expect(at(a,2067).fiSSNancy).toBe(0);expect(at(a,2068).fiSSNancy).toBeGreaterThan(0);
  expect(at(a,2068).gross).toBe(0);expect(at(a,2068).fiSS).toBeGreaterThan(0);
 });
 it('turning SS off removes all benefits while 75% pays exactly 75% with unchanged earnings and expenses',()=>{
  const a=analyze();const [none,reduced,full]=a.ssComparisons;
  for(let i=0;i<full.result.R.length;i++){
   const x=full.result.R[i],z=none.result.R[i],r=reduced.result.R[i];
   expect(z.fiSS).toBe(0);expect(Math.abs(r.fiSS-x.fiSS*.75)).toBeLessThanOrEqual(1);
   expect(x.gross).toBe(z.gross);for(const k of ['hFull','tuFull','ccFull'])expect(x[k]).toBe(z[k]);expect(x.livFullParts).toEqual(z.livFullParts);
  }
 });
 it('later-life work has independent windows, gross amounts and growth, with no double-counting after late regular retirement',()=>{
  const a=analyze({nancyBirthYear:1993,normLateIncome:50000,nancyLateIncome:100000,normLateStart:65,nancyLateStart:66,normLateEnd:67,nancyLateEnd:68,normLateGrowth:.03,nancyLateGrowth:0});
  expect(at(a,2058).normCash).toBe(50000);expect(at(a,2058).nancyG).toBe(0);
  expect(at(a,2059).normCash).toBe(51500);expect(at(a,2059).nancyG).toBe(100000);
  expect(at(a,2061).normCash).toBe(0);expect(at(a,2061).nancyG).toBe(100000);expect(at(a,2062).nancyG).toBe(0);
  const b=analyze({normStopAge:68,normLateIncome:50000,normLateGrowth:0});expect(at(b,2060).normCash).toBeGreaterThan(50000);expect(at(b,2061).normCash).toBe(50000);
  expect(at(a,2059).fiNancyOverhead).toBe(p.nancyPracticeOverhead);expect(at(a,2059).tax).toBeGreaterThan(at(analyze(),2059).tax);
 });
 it('includes SS federal tax but excludes SS from payroll and NY/NJ tax',()=>{
  const zero={...p,pretax401k:0,pretaxBenefits:0,_normW2:0,_nancyW2:0,_nancySE:0,_retirementIncome:100000};
  for(const mode of ['brooklyn','deal']){
   const q={...zero,locationConfig:{mode,moveYear:2031}},x=M.calcTax(0,q,2060,0),y=M.calcTax(0,{...q,_socialSecurity:60000},2060,0);
   expect(y.federal).toBeGreaterThan(x.federal);expect(y.state).toBe(x.state);expect(y.city).toBe(x.city);expect(y.fica).toBe(0);expect(y.taxableSS).toBe(51000);
  }
 });
 it('includes realized gains in taxable SS and reconciles cash and retirement year by year in both locations',()=>{
  for(const mode of ['brooklyn','deal']){
   const q={...p,startingLiquid:1e7,startingStripeEquity:0,k401Start:0,locationConfig:{mode,moveYear:2031}},a=analyze({},q),R=a.result.R;
   expect(R.some(r=>r.fiSSGainTax>0)).toBe(true);
   for(let i=1;i<R.length;i++){
    const r=R[i],last=R[i-1];if(r.yr<2034)continue;
    const cashFlow=r.flowFull-r.dpOut+r.sSold+r.sHold+r.fiRetDraw-r.sGainTax-r.txS-r.fiRetTax-r.fiSSGainTax;
    const expected=(last.liq>0?last.liq*(1+q.investReturn):last.liq)+cashFlow*(1+q.investReturn/2);
    expect(Math.abs(r.liq-expected),r.yr+' cash').toBeLessThan(5);
    expect(Math.abs(r.k401-(last.k401*(1+q.investReturn)+r.fiContribution*(1+q.investReturn/2)-r.fiRetDraw)),r.yr+' retirement').toBeLessThan(2);
    expect(r.netWorth).toBe(r.liq+r.sEnd+r.eq+r.otherAssets-r.otherDebt+r.k401);
   }
  }
 });
 it('adds Medicare once from 65 and applies B/D IRMAA to lagged MAGI',()=>{
  const c=F.config(p,{}),base=S.medicare(p,c,2058,0),high=S.medicare(p,c,2058,1e8);
  expect(base.people).toBe(1);expect(base.base).toBeCloseTo(202.9*12*(1+c.healthInflation)**32);expect(S.medicare(p,c,2063,0).people).toBe(2);expect(high.irmaa).toBeGreaterThan(0);
  expect(S.medicare(p,c,2057,1e8).incremental).toBe(0);
  const credit=S.medicare(p,{...c,medicareCredit:1e8},2058,0);expect(credit.incremental).toBe(0);
  const a=analyze();expect(at(a,2058).fiMedicare).toBeGreaterThan(0);
  const lag=at(a,2056).fiMagi;expect(at(a,2058).fiMedicare).toBe(Math.round(S.medicare(p,c,2058,lag).incremental));
 });
 it('retains nominal / real consistency for an SSA estimate override and does not silently infer its earnings assumptions',()=>{
  const c=F.config(p,{normSSMonthly:2500,ssCola:.02}),e=S.create(p,c),year=c.normBirthYear+67;
  const r=e.step(year,0,0);expect(r.norm).toBe(Math.floor(2500*(1+p.expenseInflation)**(year-p.planStartYear))*12);
  expect(e.step(year+1,0,0).norm).toBe(Math.floor(2500*(1+p.expenseInflation)**(year-p.planStartYear)*1.02)*12);
 });
 it('computes minimum real and nominal balances separately and Monte Carlo reconciles when volatility is zero',()=>{
  const a=analyze({}, {...p,mcVol:0});
  const expected=Math.min(...a.result.R.filter(r=>r.yr>=2034).map(r=>F.accessible(r,p,a.c)/(1+p.expenseInflation)**(r.yr-p.planStartYear)));
  expect(a.minReal).toBeCloseTo(expected,5);
  const mc=M.runMonteCarlo(a.plan,2,'lognormal');
  for(let i=0;i<a.result.R.length;i++)expect(mc.band.p50[i]).toBeCloseTo(a.result.R[i].netWorth,0);
 });
 it('the earliest exit and added capital targets reproduce independent full-horizon engine runs',()=>{
  const a=F.analyze(p,{},M,{stresses:false});
  for(const x of a.ssComparisons){
   if(x.earliest){const t=analyze({ssLevel:x.level,transitionYear:x.earliest});expect(t.status).toBe('Sustainable under assumptions');}
   if(x.additionalCapital!=null){const q={...a.plan,fiConfig:{...a.c,ssLevel:x.level},_fiExtraCapital:x.additionalCapital};expect(F.summary(M.run(q),q,q.fiConfig).status).toBe('Sustainable under assumptions');}
   const x90=x.result.R.at(-1);expect(x90.yr).toBeGreaterThanOrEqual(2083);
  }
 });
});
