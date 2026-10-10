import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import Suggest from '../public/suggest.js';
import Model from '../public/model.js';
import Budget from '../public/budget.js';
function presentation(){
 const P={planStartYear:2026,expenseInflation:.03,numKids:0,housingMode:'rent',planItems:[]};
 const ctx={P,_budgetScope:'year',SUB_VIEWS:{projection:{views:[]}},MORE_ACTIONS:[],_planLoaded:false,afParams(){},PlannerSuggest:Suggest,PlannerTime:{year:()=>2026},LIV_LABEL:{groceries:'Groceries',clothing:'Clothing'},UI:{escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),money:v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(v)},render(){},renderHomeTab(){},renderCompareTab(){},deflate:v=>v,_reduceMotion:()=>true};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(new URL('../public/experience.js',import.meta.url),'utf8'),ctx);
 return {ctx,call:s=>vm.runInContext(s,ctx)};
}
const row=(year,parts,extra={})=>({yr:year,livFullParts:parts,hFull:0,ccFull:0,tuFull:0,...extra});
describe('focused spending and budget presentation',()=>{
 it('distinguishes overspending, underspending and missing actuals without inventing zero actuals',()=>{
  const t=presentation();t.ctx.row=row(2026,{groceries:12000,clothing:6000,medical:1200});
  t.ctx.actual={lines:{groceries:{perMonth:1500},clothing:{perMonth:400}}};
  const html=t.call('experienceRankChart(row,actual,true)');
  expect(html).toContain('data-kind="actual" data-over="true"');expect(html).toContain('$500 over plan');
  expect(html).toContain('$100 under plan');expect(html).toContain('No matched actuals');
 });
 it('compares future guides in purchasing power rather than treating inflation as excessive spending',()=>{
  const t=presentation();t.ctx.row=row(2036,{groceries:12000*1.03**10});
  expect(t.call('experienceFutureChecks(P,row)')).toHaveLength(0);
 });
 it('shows review prompts rather than actual-budget verdicts in future years',()=>{
  const t=presentation();t.ctx.row=row(2036,{clothing:100000});
  const html=t.call('experienceRankChart(row,null,true)');
  expect(html).toContain('Needs review');expect(html).toContain('Above household guide · review');expect(html).not.toContain('No matched actuals');
  t.call("budgetRankMode='over'");expect(t.call('experienceRankChart(row,null,true)')).toContain('Assumptions worth reviewing');
 });
 it('includes one-off costs and signed adjustments in the spending plan',()=>{
  const t=presentation();t.ctx.row=row(2036,{groceries:12000},{eAdj:-1200});
  const ranked=t.call("experienceBudgetRanking(row,null,'size')");
  expect(ranked.find(x=>x.key==='oneoff').planned).toBe(-100);
  expect(t.call('experienceRankChart(row,null,true)')).toContain('One-off costs &amp; adjustments');
 });
 it('shows all categories on request without changing plan parameters',()=>{
  const t=presentation();t.ctx.row=row(2026,Object.fromEntries(Array.from({length:10},(_,i)=>['line'+i,12000+i*1200])));
  const before=JSON.stringify(t.ctx.P);expect((t.call('experienceRankChart(row,null,true)').match(/class="ex-rank-row"/g)||[])).toHaveLength(8);
  t.call('budgetShowAll=true');expect((t.call('experienceRankChart(row,null,true)').match(/class="ex-rank-row"/g)||[])).toHaveLength(10);expect(JSON.stringify(t.ctx.P)).toBe(before);
 });
 it('opens collapsed ancestors and the relevant editor when a category is selected',()=>{
  const t=presentation(),ancestor={tagName:'DETAILS',dataset:{fold:'budget-editor'},open:false,parentElement:null};
  const detail={hidden:true};let scrolled=false,clicked=false;
  const el={parentElement:ancestor,classList:{add(){}},scrollIntoView(){scrolled=true},querySelector:sel=>sel==='.ex-row-detail'?detail:{click(){clicked=true;detail.hidden=false}}};
  t.ctx.document={querySelector:()=>el,querySelectorAll:()=>[]};
  t.call("experienceBudgetReveal('groceries')");expect(ancestor.open).toBe(true);expect(detail.hidden).toBe(false);expect(scrolled&&clicked).toBe(true);
 });
 it('makes every cash-path year keyboard reachable and separates cash shortfalls from surpluses',()=>{
  const t=presentation();t.ctx.rows=[{yr:2026,incFull:120000,totEFull:100000},{yr:2027,incFull:90000,totEFull:100000}];
  const html=t.call('experienceCashPath(rows,2027)');expect(html).toContain('cash shortfall');expect(html).toContain('cash surplus');expect((html.match(/tabindex="0"/g)||[])).toHaveLength(2);expect(html).toContain('lifeOpenYear(2027)');expect(html).not.toContain('NaN');
 });
 it('separates total after-tax income from cash-only gaps',()=>{
  const t=presentation();t.ctx.rows=[
   {yr:2026,inc:10000,incFull:90000,netTC:150000,totEFull:120000},
   {yr:2027,incFull:110000,netTC:160000,totEFull:140000}
  ];
  const income=t.call('experienceIncomeReadout(rows,\'income\')');
  expect(income.gaps).toHaveLength(0);expect(income.pressure.yr).toBe(2027);expect(income.monthly).toBeCloseTo(20000/12);
  const cash=t.call("experienceIncomeReadout(rows,'cash')");
  expect(cash.gaps).toHaveLength(2);expect(cash.monthly).toBe(2500);
  const html=t.call("experienceCashPath(rows,2027,'income')");
  expect(html).toContain('income surplus');expect(html).not.toContain('cash shortfall');expect(html).not.toContain('NaN');
 });
 it('switches the displayed basis without changing compensation or saved assumptions',()=>{
  const t=presentation(),before=JSON.stringify(t.ctx.P);let renders=0;t.ctx.render=()=>{renders++};
  expect(t.call('overviewIncomeView')).toBe('flex');
  t.call("setOverviewIncomeView('cash')");expect(t.call('overviewIncomeView')).toBe('cash');
  t.call("setOverviewIncomeView('income')");expect(t.call('overviewIncomeView')).toBe('income');
  expect(JSON.stringify(t.ctx.P)).toBe(before);expect(renders).toBe(2);
 });
 it('shows an actionable guide in selected-year dollars and clears high and low alerts after applying it',()=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
  for(const year of [2027,2043])for(const amount of [1,100000]){
   const t=presentation();t.ctx.P={...D,planStartYear:2026,observedOn:null,masterBudget:true,budgetRules:{shopping:[{from:2026,kind:'amount',value:amount}]}};
   const before=Model.run(t.ctx.P).R;t.ctx.row=before.find(r=>r.yr===year);
   const g=t.call("experienceBudgetGuide(P,row,'shopping')");expect(g.status).not.toBe('within');
   const detail=t.call("experienceBudgetGuideHtml(P,row,'shopping')");expect(detail).toContain('Use ');expect(detail).toContain('for '+year+' only');expect(detail).toContain('Changes '+year+' only');
   const edit=Budget.edit(t.ctx.P,{category:'shopping',year,scope:'year',input:{kind:'amount',annual:g.annual}});
   Object.assign(t.ctx.P,{budgetRules:edit.budgetRules},edit.pins);
   const after=Model.run(t.ctx.P).R;t.ctx.row=after.find(r=>r.yr===year);
   expect(t.call("experienceBudgetGuide(P,row,'shopping').status")).toBe('within');
   expect(t.call('experienceFutureChecks(P,row)').some(c=>c.line==='shopping')).toBe(false);
   expect(after.find(r=>r.yr===year+1).livFullParts.shopping).toBe(before.find(r=>r.yr===year+1).livFullParts.shopping);
  }
 });
 it('honors the selected onward scope and can carry an existing one-year recommendation forward',()=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
  for(const pinned of [false,true]){
   const t=presentation();t.ctx.P={...D,planStartYear:2026,observedOn:null};t.ctx._budgetScope='onward';
   if(pinned)t.ctx.P.livingClothingY2=6000;else t.ctx.P.livingClothingY2=100000;
   t.ctx.run=Model.run;t.ctx.PlannerBudget=Budget;t.ctx.experienceBudgetReveal=()=>{};
   let label='';t.ctx.budgetApply=(edit,l)=>{label=l;Object.assign(t.ctx.P,{budgetRules:edit.budgetRules});for(const [k,v]of Object.entries(edit.pins)){if(v==null)delete t.ctx.P[k];else t.ctx.P[k]=v;}};
   t.ctx.row=Model.run(t.ctx.P).R.find(r=>r.yr===2028);
   const guide=t.call("experienceBudgetGuideHtml(P,row,'clothing')");expect(guide).toContain(pinned?'Carry this amount forward from 2028':'from 2028 on');
   t.call("experienceApplyBudgetGuide('clothing',2028)");expect(label).toContain('from 2028 on');
   const R=Model.run(t.ctx.P).R,amount=R.find(r=>r.yr===2028).livFullParts.clothing;
   expect(R.find(r=>r.yr===2029).livFullParts.clothing).toBe(Math.round(amount*(1+t.ctx.P.expenseInflation)));
   expect(t.ctx.P.livingClothingY2).toBeUndefined();
  }
 });
 it('keeps an unaccepted ongoing camp cost visible in later camp years',()=>{
  const t=presentation();Object.assign(t.ctx.P,{numKids:1,kid1Birth:2027});
  const ongoing=t.call('experiencePendingSuggestions(P,2036)');
  expect(ongoing.some(e=>e.id==='camp-1-2027'&&e.year===2036)).toBe(true);
  t.ctx.P.planItems=[{sid:'camp-1-2027'}];expect(t.call('experiencePendingSuggestions(P,2036)').some(e=>e.id==='camp-1-2027')).toBe(false);
 });
 it('keeps camp and bar mitzvah suggestions pending until explicitly added',()=>{
  const t=presentation();Object.assign(t.ctx.P,{numKids:1,kid1Birth:2027});
  const before=JSON.stringify(t.ctx.P);expect(Suggest.pending(t.ctx.P,2032,0).some(x=>x.id.startsWith('camp-'))).toBe(true);expect(Suggest.pending(t.ctx.P,2040,0).some(x=>x.id.startsWith('mitzvah-'))).toBe(true);expect(JSON.stringify(t.ctx.P)).toBe(before);
 });
});

describe('investable asset display',()=>{
 it('includes vested Stripe and other net assets while excluding home and retirement without double counting sales',()=>{
  const t=presentation();t.ctx.asset={liq:500000,sEnd:2000000,otherAssets:50000,otherDebt:10000,eq:1000000,k401:700000,nwExRetHome:2540000};
  expect(t.call('experienceInvestableAssets(asset)')).toBe(2540000);
  t.ctx.asset={liq:1500000,sEnd:1000000,otherAssets:50000,otherDebt:10000};
  expect(t.call('experienceInvestableAssets(asset)')).toBe(2540000);
 });
});

describe('timeline legend isolation',()=>{
 it('isolates, switches and restores datasets without changing the plan',()=>{
  const t=presentation(),before=JSON.stringify(t.ctx.P),visible=[true,true],pressed=['true','true'];let updates=0;
  t.ctx.charts={main:{data:{datasets:[{},{}]},setDatasetVisibility:(i,v)=>visible[i]=v,update:()=>updates++}};
  t.ctx.document={querySelectorAll:()=>pressed.map((_,i)=>({setAttribute:(k,v)=>pressed[i]=v}))};
  t.call('lifeIsolateSeries(1)');expect(visible).toEqual([false,true]);expect(pressed).toEqual(['false','true']);
  t.call('lifeIsolateSeries(0)');expect(visible).toEqual([true,false]);
  t.call('lifeIsolateSeries(0)');expect(visible).toEqual([true,true]);expect(pressed).toEqual(['true','true']);
  expect(updates).toBe(3);expect(JSON.stringify(t.ctx.P)).toBe(before);
  t.ctx.render=()=>{};t.call('lifeIsolateSeries(1)');t.call("lifeSetMode('cash')");expect(t.call('lifeIsolated')).toBe(null);
 });
});

describe('shared wealth basis',()=>{
 it('uses the same retirement selection as Overview without changing asset components',()=>{
  const t=presentation();t.ctx.asset={liq:500000,sEnd:2000000,eq:1000000,k401:700000,nw:3500000,netWorth:4200000,nwExRetHome:2500000};
  t.ctx.cockpitExRet=true;expect(t.call('experienceTimelineWealth(asset)')).toBe(3500000);
  t.ctx.cockpitExRet=false;expect(t.call('experienceTimelineWealth(asset)')).toBe(4200000);
  expect(t.call('experienceInvestableAssets(asset)')).toBe(2500000);
 });
});

describe('Overview and Future chart reconciliation',()=>{
 it('plots the same year-end wealth and Stripe-inclusive asset values in either retirement basis',()=>{
  const t=presentation();vm.runInContext(fs.readFileSync(new URL('../public/cockpit.js',import.meta.url),'utf8'),t.ctx);
  t.ctx.P={planStartYear:2026,startingLiquid:100,startingStripeEquity:200,otherAssets:40,otherDebt:10,k401Start:50};
  t.ctx.R=[{yr:2026,liq:110,sEnd:220,otherAssets:40,otherDebt:10,k401:55,nw:360,netWorth:415,nwExRetHome:360,eq:0}];
  t.ctx.cockpitMilestones=()=>[];t.ctx.runMonteCarlo=()=>{throw Error('no band')};t.ctx.inflationView=false;t.ctx.charts={};
  t.ctx.document={getElementById:()=>({innerHTML:''})};t.ctx.Chart=class{constructor(el,config){this.data=config.data;}};
  for(const ex of [false,true]){t.ctx.cockpitExRet=ex;t.call('cockpitDrawChart(R,P,2026)');
   const ds=t.ctx.charts.cockpit.data.datasets;
   expect(ds[0].data[1]).toBe(t.call('experienceTimelineWealth(R[0])'));
   expect(ds[1].data).toEqual([330,t.call('experienceInvestableAssets(R[0])')]);
  }
 });
});
