import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import M from '../public/model.js';
import F from '../public/financial-independence.js';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const p={...D,observedOn:null,normManualThroughYear:2037};
const analyze=(input={},params=p)=>F.analyze(params,input,M,{scan:false,stresses:false});
describe('Financial Independence overlay uses the shared engine',()=>{
 it('does not mutate the selected case and disabled configuration is identical to the original',()=>{
  const before=JSON.stringify(p),a=analyze();expect(JSON.stringify(p)).toBe(before);
  expect(M.run({...p,fiConfig:{enabled:false}})).toEqual(M.run(p));
  expect(a.result.R.filter(r=>r.yr<2034)).toEqual(a.original.R.filter(r=>r.yr<2034));
 });
 it('replaces compensation permanently, removes new equity and employer benefits, preserves vested assets',()=>{
  const a=analyze();for(const r of a.result.R.filter(r=>r.yr>=2034&&r.yr<2058)){
   expect(r.normCash).toBeCloseTo(150000*1.02**(r.yr-2034),0);expect(r.normStock).toBe(0);expect(r.sAdded).toBe(0);expect(r.fiEmployerMatch).toBe(0);expect(r.fiContribution).toBe(0);
  }
  const r=a.result.R.find(r=>r.yr===2034);expect(r.sBeg).toBe(a.original.R.find(r=>r.yr===2034).sBeg);expect(r.sEnd).toBeGreaterThan(0);
 });
 it('preserves every spending component through the extended lifetime, even for income-based budget rules',()=>{
  for(const mode of ['brooklyn','deal']){
   const q={...p,locationConfig:{mode,moveYear:2031},budgetRules:{charity:[{from:2030,kind:'pct',value:.05,basis:'gross'}]}};
   const a=analyze({},q);for(let i=0;i<a.result.R.length;i++){
    const x=a.result.R[i],y=a.original.R[i];for(const k of ['hFull','ccFull','tuFull','eAdj','totEFull'])expect(x[k],k+' '+x.yr).toBe(y[k]);expect(x.livFullParts).toEqual(y.livFullParts);
   }
  }
 });
 it('Nancy revenue is before overhead and payroll uses her net business income',()=>{
  const a=analyze(),r=a.result.R.find(r=>r.yr===2034),q={...p,pretax401k:0,pretaxBenefits:0,_normW2:150000,_nancyW2:0,_nancySE:200000-p.nancyPracticeOverhead-p.nancyHomeOfficeDeduct,_nancyOverhead:p.nancyPracticeOverhead};
  const t=M.calcTax(350000,q,2034,3);expect(r.nancyG).toBe(200000);expect(r.fiNancyOverhead).toBe(p.nancyPracticeOverhead);expect(r.netTC).toBe(t.net);
 });
 it('consulting pays both sides of payroll tax and deducts its operating expenses',()=>{
  const w=analyze(),c=analyze({normType:'consulting'}),o=analyze({normType:'consulting',consultingOverhead:12000});
  const at=a=>a.result.R.find(r=>r.yr===2034);
  expect(at(c).tax).toBeGreaterThan(at(w).tax);expect(at(o).fiNormSE).toBe(138000);expect(at(o).netTC).toBeLessThan(at(c).netTC);
 });
 it('changes both incomes separately and stops each on its own retirement date',()=>{
  const a=analyze({normGrowth:0,nancyGrowth:.03,normStopAge:50,nancyStopAge:55});
  expect(a.result.R.find(r=>r.yr===2035).normCash).toBe(150000);expect(a.result.R.find(r=>r.yr===2035).nancyG).toBe(206000);
  expect(a.result.R.find(r=>r.yr===2043).normCash).toBe(0);expect(a.result.R.find(r=>r.yr===2043).nancyG).toBeGreaterThan(0);expect(a.result.R.find(r=>r.yr===2048).nancyG).toBe(0);
 });
 it('has no hidden threshold and extends until both people reach 90',()=>{
  const a=analyze({horizonAge:70,nancyBirthYear:1996});expect(a.result.R.at(-1).yr).toBe(2086);expect(a.milestones.map(x=>x.age)).toEqual([60,70,80,90]);
  const tiny=analyze({normIncome:0,nancyIncome:0},{...p,startingLiquid:1,startingStripeEquity:0,k401Start:0});expect(tiny.status).toBe('Unsustainable');expect(tiny.failYear).not.toBeNull();
 });
 it('excludes home and private investments and applies estimated Stripe sale tax to accessibility',()=>{
  const c=F.config(p,{}),r={yr:2034,liq:100000,sEnd:200000,sBasis:100000,capGainsRate:.3,k401:500000,eq:9e6,otherAssets:8e6};
  expect(F.accessible(r,{otherDebt:0},c)).toBe(270000);expect(F.accessible({...r,yr:2053},{otherDebt:0},c)).toBe(770000);
 });
 it('does not spend retirement accounts before 60, applies ordinary tax and RMDs without phantom assets',()=>{
  const a=analyze({normIncome:0,nancyIncome:0,reserve:0},{...p,startingLiquid:2500000,startingStripeEquity:0,k401Start:10000000});
  for(const r of a.result.R.filter(r=>r.yr<2053))expect(r.fiRetDraw).toBe(0);
  expect(a.result.R.some(r=>r.fiRetDraw>0)).toBe(true);expect(a.result.R.some(r=>r.fiRetTax>0)).toBe(true);
  const R=a.result.R;for(let i=1;i<R.length;i++){const r=R[i],last=R[i-1];if(r.yr<2034)continue;
   expect(Math.abs(r.k401-(last.k401*(1+p.investReturn)-r.fiRetDraw))).toBeLessThan(2);
   expect(r.netWorth).toBe(r.liq+r.sEnd+r.eq+r.otherAssets-r.otherDebt+r.k401);
  }
 });
 it('RMD at 75 uses the prior ending balance divided by 24.6 and does not incur FICA',()=>{
  const a=analyze({normIncome:0,nancyIncome:0,reserve:0},{...p,startingLiquid:1e8,k401Start:1e7});
  const before=a.result.R.find(r=>r.yr===2067),r=a.result.R.find(r=>r.yr===2068);expect(r.fiRetDraw).toBeCloseTo(before.k401/24.6,0);
  const base=M.calcTax(0,{...p,pretax401k:0,pretaxBenefits:0,_normW2:0,_nancyW2:0,_nancySE:0},2068,0),ret=M.calcTax(0,{...p,pretax401k:0,pretaxBenefits:0,_normW2:0,_nancyW2:0,_nancySE:0,_retirementIncome:100000},2068,0);expect(ret.fica).toBe(base.fica);expect(ret.allInTax).toBeGreaterThan(base.allInTax);
 });
 it('honors blocked tenders, documented vests only, and separately added health coverage',()=>{
  const base=analyze(),vest=analyze({vests:{2034:20000}});expect(vest.result.R.find(r=>r.yr===2034).normStock).toBe(20000);expect(vest.result.R.find(r=>r.yr===2035).normStock).toBe(0);
  const health=analyze({extraHealth:18000});expect(health.transition.totEFull-base.transition.totEFull).toBe(18000);
  const blocked=analyze({normIncome:0,nancyIncome:0},{...p,_annualStress:{2034:{stripeSalesBlocked:true}}});expect(blocked.transition.sHold).toBe(0);
 });
 it('the 30% downturn changes portfolio returns, never lifestyle expenses',()=>{
  const b=analyze(),d=analyze({stress:'downturn'});expect(d.transition.totEFull).toBe(b.transition.totEFull);expect(d.transition.liq+d.transition.k401).toBeLessThan(b.transition.liq+b.transition.k401);
 });
 it('search statuses come from independent engine runs rather than assigned example years',()=>{
  const a=F.analyze({...p,startingLiquid:20000000},{},M,{stresses:false});expect(a.earliest).not.toBeNull();
  for(const entry of a.candidates.filter(x=>[2031,2034,2040].includes(x.year))){const t=analyze({transitionYear:entry.year},{...p,startingLiquid:20000000});expect(entry.status).toBe(t.status);}
 });
 it('uses the original Monte Carlo engine through age 90',()=>{
  const a=analyze(),mc=M.runMonteCarlo(a.plan,5);expect(mc.band.p50).toHaveLength(a.result.R.length);expect(mc.ruinPct).toBeGreaterThanOrEqual(0);expect(mc.ruinPct).toBeLessThanOrEqual(100);
 });
});

describe('Financial Independence presentation and save isolation',()=>{
 function ui(){
  const host={innerHTML:'',querySelectorAll:()=>[]};const ctx={P:structuredClone(p),scenarios:[{name:'Base Case'}],activeScenarioIdx:0,PlannerFI:F,run:M.run,runMonteCarlo:M.runMonteCarlo,Chart:class{constructor(_,o){this.options=o;}destroy(){}},document:{getElementById:id=>id==='fiRoot'?host:id==='fiSaveName'?{value:'Financial Independence — 2034'}:id==='fiSaveButton'?{disabled:false}:{}},saved:[],keepAssumptions:x=>structuredClone(x),advUuid:()=> 'test-fi-case',fetch:async(_,o)=>{ctx.saved.push(JSON.parse(o.body));return {ok:true}},showToast(){},renderCaseControl(){},savePlannerState(){},setTimeout};vm.createContext(ctx);vm.runInContext(fs.readFileSync(new URL('../public/financial-independence-ui.js',import.meta.url),'utf8'),ctx);return {ctx,host,call:s=>vm.runInContext(s,ctx)};
 }
 it('renders the primary answer, chart, cash flow and actionable controls without editing P',()=>{
  const t=ui(),before=JSON.stringify(t.ctx.P);t.call('renderFinancialIndependence()');expect(t.host.innerHTML).toContain('Make work a choice.');expect(t.host.innerHTML).toContain('fiTrajectory');expect(t.host.innerHTML).toContain('2034');t.call("fiEdit('normIncome',175000)");expect(JSON.stringify(t.ctx.P)).toBe(before);expect(t.host.innerHTML).toContain('175000');
  t.call('fiSwitch()');expect(t.host.innerHTML).toContain('Your original plan is unchanged.');expect(JSON.stringify(t.ctx.P)).toBe(before);
 });
 it('saves a distinct reusable scenario with no transient expense snapshots or mutations',async()=>{
  const t=ui(),before=JSON.stringify(t.ctx.P);await t.call('fiSave()');expect(t.ctx.saved).toHaveLength(1);const s=t.ctx.saved[0];expect(s.name).toBe('Financial Independence — 2034');expect(s.params.fiConfig.enabled).toBe(true);expect(s.params._fiPrepared).toBeUndefined();expect(s.params._fiExpenses).toBeUndefined();expect(JSON.stringify(t.ctx.P)).toBe(before);expect(t.ctx.scenarios[0].name).toBe('Base Case');
 });
 it('clears stale Monte Carlo results when the underlying case changes',()=>{
  const t=ui();t.call('renderFinancialIndependence();fiSimulation={ruinPct:0};');t.ctx.P.investReturn=.03;t.call('renderFinancialIndependence()');expect(t.call('fiSimulation')).toBeNull();
 });
});
