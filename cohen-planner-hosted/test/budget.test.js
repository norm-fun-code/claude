import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const B=require('../public/budget.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const plan=(o)=>({...D,planStartYear:2026,observedOn:null,...o});
const rows=(o)=>M.run(plan(o)).R;
const at=(R,y)=>R.find(r=>r.yr===y);
const base=rows();

describe('budget rules in the model',()=>{
 it('change nothing when there are none, or when they are empty',()=>{
  expect(M.run(plan({budgetRules:{}}))).toEqual(M.run(plan()));
  expect(M.run(plan({headroomShift:0}))).toEqual(M.run(plan()));
  expect(at(base,2030).livSrc.groceries).toBe('model');
 });
 it('an amount rule starts in its year and grows at expense inflation',()=>{
  const R=rows({budgetRules:{groceries:[{from:2028,kind:'amount',value:20000}]}});
  expect(at(R,2027).livFullParts.groceries).toBe(at(base,2027).livFullParts.groceries);
  expect(at(R,2028).livFullParts.groceries).toBe(20000);
  expect(at(R,2031).livFullParts.groceries).toBe(Math.round(20000*1.03**3));
  expect(at(R,2031).livSrc.groceries).toBe('rule');
 });
 it('a tied percentage moves with income, net or gross',()=>{
  const net=rows({budgetRules:{dining:[{from:2027,kind:'pct',value:.05,basis:'net'}]}});
  const gross=rows({budgetRules:{dining:[{from:2027,kind:'pct',value:.02,basis:'gross'}]}});
  for(const y of [2027,2035,2050]){
   expect(at(net,y).livFullParts.dining).toBe(Math.round(.05*at(net,y).netTC));
   expect(at(gross,y).livFullParts.dining).toBe(Math.round(.02*at(gross,y).gross));
  }
  expect(at(net,2027).livFullParts.dining).not.toBe(at(net,2035).livFullParts.dining);
 });
 it('a later segment takes over, and "model" hands the line back',()=>{
  const R=rows({budgetRules:{misc:[{from:2027,kind:'amount',value:15000},{from:2033,kind:'model'},{from:2040,kind:'amount',value:9000}]}});
  expect(at(R,2032).livFullParts.misc).toBe(Math.round(15000*1.03**5));
  expect(at(R,2033).livFullParts.misc).toBe(at(base,2033).livFullParts.misc);
  expect(at(R,2033).livSrc.misc).toBe('model');
  expect(at(R,2040).livFullParts.misc).toBe(9000);
 });
 it('a pin for one year beats the rule in force, and only that year',()=>{
  const R=rows({budgetRules:{auto:[{from:2027,kind:'amount',value:12000}]},livingAutoY5:30000});
  expect(at(R,2031).livFullParts.auto).toBe(30000);
  expect(at(R,2031).livSrc.auto).toBe('pin');
  expect(at(R,2030).livSrc.auto).toBe('rule');
  expect(at(R,2032).livFullParts.auto).toBe(Math.round(12000*1.03**5));
 });
 it('the total is still the sum of the lines, with rules in force',()=>{
  const R=rows({budgetRules:{groceries:[{from:2027,kind:'pct',value:.06,basis:'net'}],clothing:[{from:2030,kind:'amount',value:5000}]}});
  for(const r of R)expect(Object.values(r.livFullParts).reduce((t,v)=>t+v,0)).toBe(r.liv===r.livFullParts&&0||Object.values(r.livFullParts).reduce((t,v)=>t+v,0));
  for(const r of R)expect(r.totEFull).toBe(r.hFull+Object.values(r.livFullParts).reduce((t,v)=>t+v,0)+r.ccFull+r.tuFull+r.eAdj);
 });
 it('ignores a malformed rule rather than breaking the plan',()=>{
  const R=rows({budgetRules:{groceries:[{from:'x',kind:'amount',value:5},{from:2027,kind:'bogus',value:5},{from:2027,kind:'amount',value:-5}]}});
  expect(at(R,2030).livFullParts.groceries).toBe(at(base,2030).livFullParts.groceries);
 });
 it('the probe adds recurring or one-time spending and nothing else',()=>{
  const once=rows({headroomShift:10000,headroomFrom:2030,headroomTo:2030});
  expect(at(once,2030).totEFull-at(base,2030).totEFull).toBe(10000);
  expect(at(once,2031).totEFull).toBe(at(base,2031).totEFull);
  const rec=rows({headroomShift:10000,headroomFrom:2030});
  expect(at(rec,2032).totEFull-at(base,2032).totEFull).toBe(Math.round(10000*1.03**2));
 });
});

describe('turning typing into a rule',()=>{
 it('reads dollars, thousands, percentages and blanks',()=>{
  expect(B.parseInput('1650','month')).toEqual({kind:'amount',annual:19800});
  expect(B.parseInput('$24,000','year')).toEqual({kind:'amount',annual:24000});
  expect(B.parseInput('24k','year')).toEqual({kind:'amount',annual:24000});
  expect(B.parseInput('8%','year')).toEqual({kind:'pct',pct:.08});
  expect(B.parseInput('  ','year')).toEqual({kind:'clear'});
  expect(B.parseInput('abc','year')).toBe(null);
  expect(B.parseInput('-5','year')).toBe(null);
  expect(B.parseInput('140%','year')).toBe(null);
 });
 const income={net:400000,gross:650000};
 it('year scope pins; it never starts a rule',()=>{
  const p=plan();
  const e=B.edit(p,{category:'groceries',year:2031,scope:'year',input:{kind:'amount',annual:21000},income});
  expect(e.pins).toEqual({livingGroceriesY5:21000});
  expect(e.budgetRules).toEqual({});
  expect(B.edit(p,{category:'dining',year:2031,scope:'year',input:{kind:'pct',pct:.05},income}).pins).toEqual({livingDiningY5:20000});
  expect(B.edit(p,{category:'dining',year:2031,scope:'year',input:{kind:'clear'},income}).pins).toEqual({livingDiningY5:null});
 });
 it('onward scope writes a rule: dollars, sized percentage, tied percentage, or back to the model',()=>{
  const p=plan();
  const get=(input,extra)=>B.edit(p,{category:'misc',year:2029,scope:'onward',input,income,...extra}).budgetRules.misc;
  expect(get({kind:'amount',annual:15000})).toEqual([{from:2029,kind:'amount',value:15000}]);
  expect(get({kind:'pct',pct:.04})).toEqual([{from:2029,kind:'amount',value:16000,sized:{pct:.04,basis:'net'}}]);
  expect(get({kind:'pct',pct:.04,tied:true},{basis:'gross'})).toEqual([{from:2029,kind:'pct',value:.04,basis:'gross'}]);
  expect(get({kind:'clear'})).toEqual([{from:2029,kind:'model'}]);
 });
 it('replaces a rule that starts the same year, keeps the others in order, and reports later changes it did not touch',()=>{
  const p=plan({budgetRules:{misc:[{from:2027,kind:'amount',value:9000},{from:2033,kind:'amount',value:20000}]},livingMiscY9:5000});
  const e=B.edit(p,{category:'misc',year:2027,scope:'onward',input:{kind:'amount',annual:11000},income});
  expect(e.budgetRules.misc).toEqual([{from:2027,kind:'amount',value:11000},{from:2033,kind:'amount',value:20000}]);
  expect(e.notes).toEqual([{kind:'later-rule',years:[2033]},{kind:'later-pin',years:[2035]}]);
 });
 it('a pin on the year being ruled is removed, or it would hide the rule',()=>{
  const p=plan({livingMiscY3:7000});
  const e=B.edit(p,{category:'misc',year:2029,scope:'onward',input:{kind:'amount',annual:15000},income});
  expect(e.pins).toEqual({livingMiscY3:null});
  expect(e.before.pins).toEqual({livingMiscY3:7000});
 });
 it('does not mutate the plan, and refuses what it cannot place',()=>{
  const p=plan({budgetRules:{misc:[{from:2027,kind:'amount',value:9000}]}}),snap=JSON.stringify(p);
  B.edit(p,{category:'misc',year:2030,scope:'onward',input:{kind:'amount',annual:1},income});
  expect(JSON.stringify(p)).toBe(snap);
  expect(B.edit(p,{category:'nope',year:2030,scope:'year',input:{kind:'clear'},income}).ok).toBe(false);
  expect(B.edit(p,{category:'misc',year:2090,scope:'year',input:{kind:'clear'},income}).ok).toBe(false);
 });
 it('an applied edit produces exactly the figure the screen promised',()=>{
  const p=plan(),r=at(base,2031);
  const e=B.edit(p,{category:'groceries',year:2031,scope:'onward',input:{kind:'pct',pct:.07},income:{net:r.netTC,gross:r.gross}});
  const R=rows({budgetRules:e.budgetRules});
  expect(at(R,2031).livFullParts.groceries).toBe(Math.round(.07*r.netTC));
 });
 it('describes a rule in words',()=>{
  const f=v=>'$'+v;
  expect(B.describe(plan({budgetRules:{misc:[{from:2027,kind:'amount',value:9000}]}}),'misc',2030,f)).toBe('$9000 in 2027, +3% a year');
  expect(B.describe(plan({budgetRules:{misc:[{from:2027,kind:'pct',value:.04,basis:'net'}]}}),'misc',2030,f)).toBe('4% of net income, every year');
  expect(B.describe(plan({budgetRules:{misc:[{from:2027,kind:'amount',value:16000,sized:{pct:.04,basis:'net'}}]}}),'misc',2030,f)).toBe('4% of net income in 2027, then $16000 in 2027, +3% a year');
  expect(B.describe(plan(),'misc',2030,f)).toBe(null);
 });
});

describe('funding, phases and headroom',()=>{
 it('pays spending from cash first, then stock, then savings, and the parts add up',()=>{
  for(const r of base){
   const f=B.funding(r);
   expect(f.fromCash+f.fromStock+f.fromSavings).toBe(f.spend);
   expect(f.fromStock).toBeLessThanOrEqual(f.stock);
   if(f.fromSavings>0)expect(f.fromCash+f.fromStock).toBe(f.cash+f.stock);
  }
 });
 it('splits the plan into saving and drawing-down runs that cover every year once',()=>{
  const ph=B.phases(base);
  expect(ph[0].from).toBe(base[0].yr);expect(ph.at(-1).to).toBe(base.at(-1).yr);
  for(let i=1;i<ph.length;i++)expect(ph[i].from).toBe(ph[i-1].to+1);
  expect(ph.reduce((t,p)=>t+p.years,0)).toBe(base.length);
  expect(ph.reduce((t,p)=>t+p.total,0)).toBeCloseTo(base.reduce((t,r)=>t+r.flowFull,0),0);
  expect(new Set(ph.map(p=>p.kind))).toEqual(new Set(['save','draw']));
 });
 it('headroom is a threshold: that much more still works, a little more breaks',()=>{
  const P=plan(),h=B.headroom(P,M.run,2027);
  expect(h.ongoing.value).toBeGreaterThan(0);
  const ok=v=>B.feasible({...P,headroomShift:v,headroomFrom:2027,headroomTo:null},M.run);
  expect(ok(h.ongoing.value)).toBe(true);
  expect(ok(h.ongoing.value+1500)).toBe(false);
  const once=v=>B.feasible({...P,headroomShift:v,headroomFrom:2027,headroomTo:2027},M.run);
  expect(once(h.once.value)).toBe(true);expect(once(h.once.value+6000)).toBe(false);
  expect(h.stress.ongoing.value).toBeLessThan(h.ongoing.value);
 });
 it('a budget that spends more has less headroom',()=>{
  const P=plan(),lean=B.headroom(plan({budgetRules:{dining:[{from:2027,kind:'amount',value:5000}]}}),M.run,2027);
  const rich=B.headroom(plan({budgetRules:{dining:[{from:2027,kind:'amount',value:40000}]}}),M.run,2027);
  expect(lean.ongoing.value).toBeGreaterThan(rich.ongoing.value);
 });
 it('says when the plan already breaks, and where',()=>{
  const h=B.headroom(plan({liquidReserveFloor:3000000}),M.run,2027);
  expect(h.breachYear).toBeGreaterThanOrEqual(2026);
  expect(h.ongoing.value===null||h.ongoing.value<0).toBe(true);
 });
 it('can see what the model alone would have said',()=>{
  const P=plan({budgetRules:{misc:[{from:2027,kind:'amount',value:30000}]},livingDiningY4:99999});
  const R=M.run(B.modelPlan(P)).R;
  expect(at(R,2030).livFullParts.misc).toBe(at(base,2030).livFullParts.misc);
  expect(at(R,2030).livFullParts.dining).toBe(at(base,2030).livFullParts.dining);
 });
});

describe('the Budget screen',()=>{
 const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const ui=html.slice(html.indexOf('let _budgetYear='),html.indexOf('function renderSpendingTab('));
 it('is a Financial life view, served, and loaded after the model',()=>{
  expect(html).toContain("['budget','doc','Budget']");
  expect(html).toContain("else if(_todayView==='budget')renderBudgetTab(R,P);");
  expect(html).toContain('<script src="/budget.js"></script>');
  expect(html.indexOf('<script src="/budget.js"></script>')).toBeGreaterThan(html.indexOf('src="/model.js"'));
  expect(server).toContain("'budget.js'");
 });
 it('edits go through the tested edit(), save through the usual path, and can be undone',()=>{
  expect(ui).toContain('PlannerBudget.edit(P,');
  expect(ui).toMatch(/markDirty\(\);buildControls\(\);render\(\);savePlannerState\(\)/);
  expect(ui).toContain('function budgetUndoLast()');
  expect(ui).toContain('PlannerBudget.parseInput(text,_budgetUnit)');
 });
 it('typing back the figure already shown does not turn a model line into a rule',()=>{
  expect(ui).toMatch(/Math\.abs\(input\.annual-cur\.annual\)<=/);
 });
 it('offers no savings target, and no headroom tile: a plan that draws down by design needs neither',()=>{
  expect(ui).not.toMatch(/savings target|savingsTarget/);
  expect(ui).not.toContain('bd-headroom');expect(ui).not.toContain('budgetHeadroom');expect(ui).not.toContain('Headroom from');
 });
 it('shows what the model would have said beside a changed line',()=>{
  expect(ui).toContain('model says');
  expect(ui).toContain('B.modelPlan(P)');
 });
});

describe('the groups a year falls into',()=>{
 const P=plan(),R=M.run(P).R;
 it('sort every line into exactly one group, with essentials inside fixed costs',()=>{
  const all=B.BUCKETS.flatMap(b=>b.lines);
  expect(new Set(all).size).toBe(all.length);
  for(const k of M.LIV_KEYS)expect(B.BUCKETS.some(b=>b.lines.includes(k))).toBe(true);
  expect(B.bucketOf('insurance')).toBe('fixed');expect(B.bucketOf('groceries')).toBe('fixed');expect(B.bucketOf('medical')).toBe('fixed');
  expect(B.bucketOf('vacations')).toBe('discretionary');expect(B.bucketOf('charity')).toBe('discretionary');
  expect(B.bucketOf('pets')).toBe('discretionary');
  for(const k of ['saving','investing'])expect(B.BUCKETS.find(b=>b.key===k).lines).toEqual([]);
 });
 it('runs fixed, discretionary, savings, then investments',()=>{
  expect(B.BUCKETS.map(b=>b.key)).toEqual(['fixed','discretionary','saving','investing']);
  expect(B.BUCKETS.filter(b=>b.computed).map(b=>b.key)).toEqual(['saving','investing']);
 });
 it('split a surplus into savings, Stripe kept and brokerage, adding to the excess exactly',()=>{
  const sets=[P,{...P,budgetRules:{emergency:[{from:2026,kind:'pct',value:.04,basis:'net'}]}}];
  for(const Q of sets)for(const r of R){
   const a=B.allocation(Q,R,r.yr);
   expect(Math.abs(a.investing.stripe+a.investing.portfolio+a.saving.total-a.excess),String(r.yr)).toBeLessThanOrEqual(2);
   expect(a.excess*a.deficit).toBe(0);
   expect(a.saving.total).toBeLessThanOrEqual(a.saving.target);
   expect(a.saving.total).toBeLessThanOrEqual(a.excess);
   expect(a.investing.stripe).toBeGreaterThanOrEqual(-1);expect(a.investing.portfolio).toBeGreaterThanOrEqual(-1);
  }
 });
 it('says drawing down when the year runs a deficit, with nothing invested or saved',()=>{
  const r=R.find(r=>r.flowFull<-1000),Q={...P,budgetRules:{emergency:[{from:2026,kind:'amount',value:30000}]}},a=B.allocation(Q,R,r.yr);
  expect(a.deficit).toBe(-r.flowFull);expect(a.investing.total).toBe(0);expect(a.saving.total).toBe(0);
  expect(a.saving.shortfall).toBeGreaterThan(0);
 });
 it('asks nothing of a year that you set nothing for, unless the reserve is below its floor',()=>{
  expect(B.allocation(P,R,2029).saving).toMatchObject({src:'model',target:0,total:0});
  const low={...P,liquidReserveFloor:2000000},RL=M.run(low).R,a=B.allocation(low,RL,2026);
  expect(a.reserveFunded).toBe(false);
  expect(a.saving.src).toBe('model');expect(a.saving.target).toBe(a.saving.reserveGap);
  expect(a.saving.total).toBe(Math.min(a.saving.target,a.excess));
 });
 it('takes a dollar rule, a share of income or a pin, in that order of precedence from the specific',()=>{
  const row=y=>R.find(r=>r.yr===y);
  const ruled={...P,budgetRules:{emergency:[{from:2027,kind:'amount',value:10000},{from:2031,kind:'pct',value:.03,basis:'net'}]}};
  expect(B.allocation(ruled,R,2026).saving.src).toBe('model');
  expect(B.allocation(ruled,R,2028).saving).toMatchObject({src:'rule',target:Math.round(10000*1.03)});
  expect(B.allocation(ruled,R,2033).saving.target).toBe(Math.round(.03*row(2033).netTC));
  const pinned={...ruled,savingEmergencyY7:50000};   // 2033
  expect(B.allocation(pinned,R,2033).saving).toMatchObject({src:'pin',target:50000});
  expect(B.allocation(pinned,R,2034).saving.src).toBe('rule');
 });
 it('funds savings from left-over cash first, then from the Stripe shares the plan keeps, and says so',()=>{
  const Q={...P,budgetRules:{emergency:[{from:2026,kind:'amount',value:60000}]}};
  const a=B.allocation(Q,R,2029);
  expect(a.saving.fromCash+a.saving.fromShares).toBe(a.saving.total);
  expect(a.saving.fromCash).toBe(Math.min(a.saving.total,a.excess-Math.min(R.find(r=>r.yr===2029).sRet,a.excess)));
  expect(a.saving.fromShares).toBeGreaterThan(0);
  const base=B.allocation(P,R,2029);
  expect(a.investing.stripe).toBe(base.investing.stripe-a.saving.fromShares);
 });
 it('adds up what has been set aside, and what that is in months of fixed costs',()=>{
  const Q={...P,budgetRules:{emergency:[{from:2027,kind:'amount',value:20000}]}};
  const e=B.emergencySaved(Q,R,2030);
  expect(e.total).toBe([2027,2028,2029,2030].map(y=>B.allocation(Q,R,y).saving.total).reduce((t,v)=>t+v,0));
  expect(e.months).toBeCloseTo(e.total/B.allocation(Q,R,2030).fixedPerMonth,0);
  expect(B.emergencySaved(P,R,2030).total).toBe(0);
 });
 it('states the reserve in months of fixed costs, and the 401(k) as outside the surplus',()=>{
  const a=B.allocation(P,R,2030);
  expect(a.reserveMonths).toBeCloseTo(P.liquidReserveFloor/a.fixedPerMonth,0);
  expect(a.investing.k401).toBe(P.pretax401k);
 });
 it('does not change the projection, and covers every year once',()=>{
  const Q={...P,budgetRules:{emergency:[{from:2026,kind:'pct',value:.1,basis:'net'}]},savingEmergencyY3:12345};
  expect(M.run(Q)).toEqual(M.run(P));
  const before=JSON.stringify(M.run(P).R);B.allocationSeries(P,R);expect(JSON.stringify(M.run(P).R)).toBe(before);
  expect(B.allocationSeries(P,R).map(a=>a.year)).toEqual(R.map(r=>r.yr));
  expect(B.allocation(P,R,1999)).toBe(null);
 });
 it('is edited like any line: a share becomes dollars or a rule, and a pin keeps its own key',()=>{
  const income={net:400000,gross:650000};
  expect(B.edit(P,{category:'emergency',year:2030,scope:'onward',input:{kind:'pct',pct:.05},basis:'net',income}).budgetRules.emergency)
    .toEqual([{from:2030,kind:'amount',value:20000,sized:{pct:.05,basis:'net'}}]);
  expect(B.edit(P,{category:'emergency',year:2030,scope:'onward',input:{kind:'pct',pct:.05,tied:true},basis:'gross',income}).budgetRules.emergency)
    .toEqual([{from:2030,kind:'pct',value:.05,basis:'gross'}]);
  expect(B.edit(P,{category:'emergency',year:2030,scope:'year',input:{kind:'amount',annual:15000},income}).pins).toEqual({savingEmergencyY4:15000});
  expect(B.edit(P,{category:'emergency',year:2030,scope:'onward',input:{kind:'clear'},income}).budgetRules.emergency).toEqual([{from:2030,kind:'model'}]);
  expect(B.edit(P,{category:'nope',year:2030,scope:'year',input:{kind:'clear'},income}).ok).toBe(false);
 });
});

describe('the groups on the Budget screen',()=>{
 const ui=html.slice(html.indexOf('let _budgetYear='),html.indexOf('function renderSpendingTab('));
 it('groups lines as fixed, essentials and discretionary, then savings and investing',()=>{
  expect(ui).toContain('B.BUCKETS.map(b=>{');
  expect(ui).not.toContain("'essential'");
  expect(ui).toContain("Where ${yr}'s money goes");
  expect(ui).not.toContain('Ramit');
  expect(ui).not.toContain('bd-ruler');
 });
 it('makes savings an editable emergency fund, and investments the Fidelity brokerage and Stripe',()=>{
  expect(ui).toContain("line(PlannerBudget.EMERGENCY,'Emergency fund'");
  expect(ui).toContain("if(cat===PlannerBudget.EMERGENCY){");
  expect(ui).toContain("computedRow('investing','Fidelity brokerage'");
  expect(ui).toContain("computedRow('investing','Stripe shares kept'");
  expect(ui).toContain('All the cash left over after savings');
  expect(ui).toContain('would mean selling Stripe shares you would otherwise keep');
  expect(ui).toContain('Drawing down');
  expect(html).toContain("emergency:'Emergency fund'");
 });
 it('moves suggestions and baselines to the bottom, collapsed, with the long check text off the rows',()=>{
  const render=ui.slice(ui.indexOf('function renderBudgetTab('));
  expect(render).toContain('${assumeHtml}${budgetNYCNotes()}${baselines}</div>`;');
  // The NYC household assumptions are not part of the scenarios card any more.
  expect(html.slice(html.indexOf('function sharedCard('),html.indexOf('function renderBudgetTab('))).not.toContain('budgetNYCNotes()');
  expect(render).toContain('Suggestions for a family like yours');
  expect(render.indexOf('class="cp-card bd-sugs"')).toBe(-1);
  expect(render).not.toContain("${chk?`<span class=\"bd-why\">");
 });
 it('lets a tuition year be clicked to budget that year',()=>{
  const tu=html.slice(html.indexOf('function budgetTuitionHtml('),html.indexOf('function renderBudgetTab('));
  expect(tu).toContain('onclick="budgetYearSet(${r.yr})"');
  expect(tu).toContain('aria-pressed="${here}"');
 });
 it('leaves the Spending Plan mode on its own grouping',()=>{
  const lens=html.slice(html.indexOf('function renderIncomeLens('),html.indexOf('let _budgetYear='));
  expect(lens.length).toBeGreaterThan(1000);
  expect(lens).toContain('IS.compute(row,basis)');expect(lens).not.toContain('B.BUCKETS');
 });
});

describe('the Budget control bar and the expense-inflation setting',()=>{
 const fnSrc=name=>html.slice(html.indexOf('function '+name+'('),html.indexOf('\n}\n',html.indexOf('function '+name+'('))+3);
 const css=fs.readFileSync(new URL('../public/ui.css',import.meta.url),'utf8');
 const run2=(P0,val)=>{
  const P={...P0},calls=[];
  new Function('P','markDirty','buildControls','render','savePlannerState','showToast',fnSrc('expInflSet')+';expInflSet('+JSON.stringify(val)+');')(P,()=>calls.push('dirty'),()=>calls.push('controls'),()=>calls.push('render'),()=>calls.push('save'),m=>calls.push('toast:'+m));
  return {P,calls};
 };
 it('keeps the year, the unit and the inflation rate in one bar that stays in view',()=>{
  const bar=html.slice(html.indexOf('<div class="bd-bar"'),html.indexOf('</div>`;',html.indexOf('<div class="bd-bar"')));
  for(const piece of ['Budget year','Show amounts per','Edits apply to','${toolsInner}'])expect(bar).toContain(piece);
  expect(html).toContain('${expInflControl()}@@JUMP@@`;');         // the tools: share basis, inflation, section chips
  expect(css).toMatch(/\.bd-bar\{position:sticky;top:0;/);
  expect(css).toContain('body:has(.demo-banner) .bd-bar{top:46px}');     // clear of the demo banner
 });
 it('sets annual expense inflation from a percentage, saves it, and says what it changes',()=>{
  const {P,calls}=run2(plan(),'4.5');
  expect(P.expenseInflation).toBeCloseTo(.045,9);
  expect(calls).toEqual(expect.arrayContaining(['dirty','controls','render','save']));
  expect(calls.find(c=>c.startsWith('toast:'))).toContain('every spending line, every year');
 });
 it('clamps to 0–15%, ignores junk, and does nothing when the rate is unchanged',()=>{
  expect(run2(plan(),'99').P.expenseInflation).toBeCloseTo(.15,9);
  expect(run2(plan(),'-3').P.expenseInflation).toBeCloseTo(.03,9);       // the minus sign is stripped: 3%, not negative
  const junk=run2(plan(),'abc');expect(junk.P.expenseInflation).toBe(plan().expenseInflation);expect(junk.calls).toEqual(['render']);
  const same=run2(plan({expenseInflation:.03}),'3.0');expect(same.calls).toEqual(['render']);
 });
 it('moves every projected year, and is the rate Real $ deflates by',()=>{
  const lo=M.run(plan({expenseInflation:.02})).R,hi=M.run(plan({expenseInflation:.05})).R;
  expect(at(hi,2040).livFullParts.groceries).toBeGreaterThan(at(lo,2040).livFullParts.groceries);
  expect(at(hi,2026).livFullParts.groceries).toBe(at(lo,2026).livFullParts.groceries);
  expect(html).toContain('function deflate(v,yr){if(!inflationView)return v;const sy=P.planStartYear||2026;return v/Math.pow(1+(P.expenseInflation||.03),yr-sy)}');
 });
 it('is also beside the Real $ button on the Trajectory views',()=>{
  expect(html).toContain("'Show future dollars in today\\u2019s purchasing power')+expInflControl('bd-infl-sm');");
 });
});

describe('Budget sections you can see and move between',()=>{
 const ui=html.slice(html.indexOf('let _budgetYear='),html.indexOf('function renderSpendingTab('));
 const css=fs.readFileSync(new URL('../public/ui.css',import.meta.url),'utf8');
 it('makes every group, and the one-off costs, its own anchored panel',()=>{
  expect(ui).toContain('class="cl-group bd-sec" id="bd-g-${b.key}"');
  expect(ui).toContain('class="cl-group bd-sec" id="bd-g-oneoff"');
  expect(css).toMatch(/\.bd-lines \.cl-group\.bd-sec\{[^}]*border-left:4px solid var\(--tier\)/);
 });
 it('puts a jump chip for each section in the pinned bar, with its share, and replaces the placeholder',()=>{
  const bar=ui.slice(ui.indexOf('<div class="bd-bar"'),ui.indexOf('</div>`;',ui.indexOf('<div class="bd-bar"')));
  expect(ui).toContain('@@JUMP@@');
  expect(ui).toContain("h=h.split('@@JUMP@@').join(jumpHtml);");     // used in the bar and, on a phone, above the lines
  expect(ui).toContain("onclick=\"budgetJump('${b.key}')\"");expect(ui).toContain("onclick=\"budgetJump('oneoff')\"");
  expect(css).toContain('.bd-jump{flex:1 1 100%;display:flex');
 });
 it('lands below the pinned bar by measuring it, not by trusting a fixed margin',()=>{
  const fn=html.slice(html.indexOf('function budgetJump('),html.indexOf('function budgetEdit('));
  expect(fn).toContain("getComputedStyle(bar).top");expect(fn).toContain('bar.offsetHeight');
  expect(fn).toContain('prefers-reduced-motion');
 });
});

describe('the Budget reads like a P&L, and every line can be set as a share of income',()=>{
 const ui=html.slice(html.indexOf('let _budgetYear='),html.indexOf('function renderSpendingTab('));
 it('starts with income: each source, gross, what comes off, and net — read from the projection',()=>{
  expect(ui).toContain('const incomeSec=');
  for(const piece of ["inRow('Norm — cash pay',row.normCash","inRow('Norm — Stripe stock at vest',row.normStock","inRow('Nancy',row.nancyG","subRow('Gross income'","subRow('Taxes'","subRow('Net income'"])expect(ui).toContain(piece);
  const r=at(M.run(plan()).R,2031);
  expect(r.normCash+r.normStock+r.nancyG).toBe(r.gross);                       // the three rows add to the gross shown
  expect(r.gross-r.tax-(r.gross-r.tax-r.netTC)).toBe(r.netTC);
 });
 it('orders it income, fixed, discretionary, the bottom line, savings, investments',()=>{
  expect(ui).toContain('const groups=incomeSec+bucketParts[0]+bucketParts[1]+bottomLine+bucketParts[2]+bucketParts[3];');
  expect(ui).toContain("<span>Net income</span>");expect(ui).toContain('Left over');
  expect(ui).toContain("budgetJump('income')");
 });
 it('sends income edits to where income is set',()=>{
  const go=html.slice(html.indexOf('function budgetGo('),html.indexOf('\n}\n',html.indexOf('function budgetGo('))+3);
  expect(go.length).toBeGreaterThan(60);
  expect(go).toContain("stripeWorkspaceSet('income');setTab('stripe')");expect(go).toContain("setTab('inputs')");
 });
 it('puts an editable percentage of income on every line, always visible, and ignores a repeat',()=>{
  expect(ui).toContain('class="bd-pct"');
  expect(ui).toContain("onchange=\"budgetCommit('${k}',this.value.replace(/[^0-9.]/g,'')+'%')\"");
  expect(ui).toMatch(/Math\.abs\(input\.pct-cur\.annual\/base\)<0\.0006/);
  const css=fs.readFileSync(new URL('../public/ui.css',import.meta.url),'utf8');
  expect(css).toContain('.bd-actions{opacity:1!important}');
 });
 it('lets the emergency fund be tied to income even when spending budgets are shared across cases',()=>{
  expect(ui).toContain('commonHousehold(P)&&k!==PlannerBudget.EMERGENCY?');
  expect(ui).toContain('commonHousehold(P)&&cat!==PlannerBudget.EMERGENCY');
 });
 it('measures the emergency fund against this case\'s income, not the shared reference schedule',()=>{
  const income={net:300000,gross:500000};
  const shared={...plan({sharedLines:{groups:Object.fromEntries(['household','fixed','essential','childcare','tuition','choice'].map(k=>[k,true]))},
    sharedBudgetIncome:{2026:{net:1000000,gross:2000000}},budgetRules:{emergency:[{from:2026,kind:'pct',value:.04,basis:'net'}],dining:[{from:2026,kind:'pct',value:.04,basis:'net'}]}})};
  expect(M.commonHousehold(shared)).toBe(true);
  expect(M.budgetValue(shared,'emergency',2030,income)).toBe(12000);        // 4% of THIS case's net
  expect(M.budgetValue(shared,'dining',2030,income)).toBe(40000);           // spending still uses the shared reference
  expect(B.describe(shared,'emergency',2030,v=>'$'+v)).toBe('4% of net income, every year');
 });
 it('shows the call-outs, in words, under the lines they are about',()=>{
  expect(ui).toContain('class="bd-callout ${chk.status}"');expect(ui).toContain("chk.status==='low'?'Looks light':'Looks high'");
  const S=require('../public/suggest.js');
  for(const line of ['dining','shopping','entertainment','vacations'])expect(S.BANDS[line]).toBeTruthy();
 });
});

describe('Budget layout: the lines come first',()=>{
 const render=html.slice(html.indexOf('function renderBudgetTab('));
 it('opens with one summary card, then the line by line, and everything else folds below',()=>{
  const at=s=>render.indexOf(s);
  expect(at('<section class="cp-card bd-buckets">')).toBeLessThan(at('<section class="cp-card bd-lines">'));
  const tail=render.slice(at('<section class="cp-card bd-lines">'));
  // After the lines come the folds, in this order. Which others sit between does not matter.
  expect(tail).toMatch(/\$\{overTimeHtml\}[\s\S]*\$\{scenarioFold\}[\s\S]*\$\{assumeHtml\}/);
  for(const piece of ['const phasesHtml=','const tuitionHtml=','const fundHtml=','const sharedHtml='])expect(render).toContain(piece);
  // None of the over-time material is emitted before the lines any more.
  const before=render.slice(0,at('<section class="cp-card bd-lines">'));
  for(const gone of ['h+=phasesHtml','h+=tuitionHtml','h+=fundHtml','h+=sharedHtml','h+=budgetTuitionHtml'])expect(before).not.toContain(gone);
 });
 it('keeps the plan shape, tuition, the year-by-year strip and the funding bar in one Over time fold, and the scenarios in another',()=>{
  const over=render.slice(render.indexOf('const overTimeHtml='),render.indexOf('const scenarioFold='));
  for(const piece of ['${phasesHtml}','${strip}','${tuitionHtml}','${fundHtml}'])expect(over).toContain(piece);
  expect(render).toContain("const scenarioFold=`<details class=\"cp-card spend-details bd-over\" ${bdFold('scenarios')}>");
 });
 it('remembers which folds are open, so a redraw does not shut the one you are reading',()=>{
  expect(html).toContain('const _bdFolds=new Set();');
  expect(html).toContain("ontoggle=\"budgetFold('${k}',this.open)\"");
  for(const k of ['over','scenarios','suggest','baselines','nyc'])expect(html).toContain(`bdFold('${k}')`);
 });
 it('gives the funding bar its own colours so teal and amber keep one meaning on the page',()=>{
  const m=html.match(/const BD_COLOR=\{([^}]+)\}/)[1];
  const groups=html.match(/const RM_COLOR=\{([^}]+)\}/)[1];
  for(const k of ['cash','stock','savings','left']){const c=m.match(new RegExp(k+":'(#[0-9a-f]+)'"))[1];expect(groups.includes(c),k).toBe(false)}
 });
});

describe('what an edit does, and feedback where you are working',()=>{
 const ui=html.slice(html.indexOf('let _budgetYear='),html.indexOf('function renderSpendingTab('));
 const css=fs.readFileSync(new URL('../public/ui.css',import.meta.url),'utf8');
 it('pins the scope toggle in the bar, and says in words which years an edit changes',()=>{
  const bar=ui.slice(ui.indexOf('<div class="bd-bar"'),ui.indexOf('</div>`;',ui.indexOf('<div class="bd-bar"')));
  expect(bar).toContain('aria-label="Edits apply to"');
  expect(bar).toContain("budgetScope('onward')");expect(bar).toContain("budgetScope('year')");
  expect(bar).toContain("`Changes ${yr}–${last}`:`Changes ${yr} only`");
  // …and not in the lines card, where it scrolled out of sight.
  const lines=ui.slice(ui.indexOf('<section class="cp-card bd-lines">'),ui.indexOf('${overTimeHtml}'));
  expect(lines).not.toContain("budgetScope('");
 });
 it('keeps the pinned bar slim on a phone by moving the tools above the lines',()=>{
  expect(css).toContain('.bd-tools{display:contents}');
  expect(css).toMatch(/@media\(max-width:760px\)\{[^}]*\.bd-bar \.bd-tools\{display:none\}/);
  expect(ui).toContain('<div class="bd-tools bd-tools-m">${toolsInner}</div>');
 });
 it('floats an undo snackbar next to the work, saying what changed and which later changes still apply',()=>{
  expect(ui).toContain('function budgetSnack(text,notes)');
  for(const fn of ['budgetApply','budgetChange'])expect(html.slice(html.indexOf('function '+fn+'('),html.indexOf('\n}\n',html.indexOf('function '+fn+'('))+3)).toContain('budgetSnack(');
  expect(ui).toContain("still ${n.years.length>1?'apply':'applies'}");
  expect(ui).not.toContain('class="bd-undo"');                   // the banner a screen away is gone
  expect(css).toContain('.bd-snack{position:fixed');
 });
 it('dismisses itself, and undo hides it',()=>{
  expect(ui).toContain('setTimeout(budgetSnackHide,12000)');
  expect(html.slice(html.indexOf('function budgetUndoLast('),html.indexOf('\n}\n',html.indexOf('function budgetUndoLast('))+3)).toContain('budgetSnackHide()');
 });
});

describe('actual against budget',()=>{
 const spend=(extra)=>({endDate:'2026-10-14',months:[
  {month:'2026-01',categories:[{name:'Groceries',net:1000},{name:'Rent',net:5500},{name:'Zorp',net:300}]},
  {month:'2026-02',categories:[{name:'Groceries',net:1200},{name:'Rent',net:5500},{name:'Zorp',net:100},{name:'Transfers',net:9000}]},
  {month:'2026-10',categories:[{name:'Groceries',net:200}]},                       // the month in progress
  {month:'2025-12',categories:[{name:'Groceries',net:9999}]},                        // another year
 ],...extra});
 it('maps the bank\'s category names to budget lines, and lets your correction win',()=>{
  const cases={Groceries:'groceries','Gas & Electric':'utilities',Gas:'auto','Restaurants & Bars':'dining','Coffee Shops':'dining','Travel & Vacation':'vacations','Health Insurance':'medical',Insurance:'insurance','Parking & Tolls':'transit',Gifts:'misc','Home Improvement':'shopping',Childcare:'childcare',Rent:'housing'};
  for(const [n,l] of Object.entries(cases))expect(B.lineOfCategory(n),n).toBe(l);
  expect(B.lineOfCategory('Zorp')).toBe(null);
  expect(B.lineOfCategory('Zorp',{zorp:'dining'})).toBe('dining');
  expect(B.lineOfCategory('Rent',{rent:'ignore'})).toBe('ignore');
  expect(B.lineOfCategory('Zorp',{zorp:'not-a-line'})).toBe(null);
 });
 it('averages the closed months of the year per month, leaving out the month in progress and other years',()=>{
  const a=B.actuals(spend(),2026,{});
  expect(a.months).toBe(2);expect(a.through).toBe('2026-02');
  expect(a.lines.groceries).toEqual({total:2200,perMonth:1100});
  expect(a.lines.housing.perMonth).toBe(5500);
 });
 it('reports what it could not map instead of guessing, and keeps ignored categories out of the total',()=>{
  const a=B.actuals(spend(),2026,{transfers:'ignore'});
  expect(a.unmapped).toEqual([{name:'Zorp',total:400,perMonth:200}]);
  expect(a.unmappedTotal).toBe(400);
  expect(a.total).toBe(2200+11000+400);                       // transfers ignored, zorp counted
  expect(a.perMonth).toBe((2200+11000+400)/2);
  const mapped=B.actuals(spend(),2026,{transfers:'ignore',zorp:'misc'});
  expect(mapped.unmapped).toEqual([]);expect(mapped.lines.misc.total).toBe(400);
 });
 it('says nothing when there are no records for the year, or the records failed',()=>{
  expect(B.actuals(spend(),2031,{})).toBe(null);
  expect(B.actuals(null,2026,{})).toBe(null);expect(B.actuals({error:'x'},2026,{})).toBe(null);
  expect(B.actuals({months:[]},2026,{})).toBe(null);
 });
 it('calls a pace on, over, under or unplanned, in both-per-month terms',()=>{
  expect(B.variance(1000,1050).status).toBe('on');
  expect(B.variance(1000,1300)).toMatchObject({status:'over',diff:300,pct:.3});
  expect(B.variance(1000,600)).toMatchObject({status:'under',diff:-400});
  expect(B.variance(0,400)).toMatchObject({status:'unplanned'});
  expect(B.variance(0,20).status).toBe('on');                 // a few dollars is not "unplanned"
  expect(B.variance(100,140).status).toBe('on');              // 40% of a small line, but under $50
 });
});

describe('actual against budget on the Budget screen',()=>{
 const ui=html.slice(html.indexOf('let _budgetYear='),html.indexOf('function renderSpendingTab('));
 it('compares only the year we are in, and loads the imported records itself',()=>{
  expect(ui).toContain('const act=yr===PlannerTime.year()?B.actuals(_spend,yr,P.monarchLineMap):null;');
  expect(ui).toContain('if(_spend===null&&!_spendLoading&&!_demoMode)loadSpending();');
  expect(html.slice(html.indexOf('async function loadSpending('),html.indexOf('\n}\n',html.indexOf('async function loadSpending('))+3)).toContain("_todayView==='budget'");
 });
 it('shows each line\'s actual pace and a verdict, offers to adopt it, and says when nothing matched',()=>{
  for(const piece of ['const actualStrip=','Actual so far <strong>','No ${yr} spending matched this line yet','budgetSetActual(','B.variance(value/12,ln.perMonth)'])expect(ui).toContain(piece);
  expect(ui).toContain("readonly||v.status==='on'?'':");           // no adopt button on a read-only line, or one already on pace
 });
 it('puts the total pace against the total budget in the summary, and mentions what did not match',()=>{
  expect(ui).toContain('Actual spending so far in ${yr}');
  expect(ui).toContain('not matched to a line');
 });
 it('lets you correct a mapping, stores it with the plan, and keeps "leave out" as a choice',()=>{
  expect(html).toContain('function budgetMapSet(name,line)');
  expect(ui).toContain('Leave out');
  expect(ui).toContain("bdFold('map')");
  expect(ui).toMatch(/\$\{overTimeHtml\}[^`]*\$\{mapFold\}[^`]*\$\{scenarioFold\}/);
 });
 it('adopting a pace is an ordinary edit, with the same scope, snackbar and undo',()=>{
  const fn=html.slice(html.indexOf('function budgetSetActual('),html.indexOf('\n}\n',html.indexOf('function budgetSetActual('))+3);
  expect(fn).toContain('PlannerBudget.edit(P,');expect(fn).toContain('budgetApply(e,');expect(fn).toContain('scope:_budgetScope');
 });
});

describe('everything you have changed',()=>{
 const f=v=>'$'+Math.round(v).toLocaleString('en-US');
 const P0=plan({
  budgetRules:{groceries:[{from:2030,kind:'amount',value:20000},{from:2027,kind:'pct',value:.05,basis:'net'},{from:2040,kind:'model'}],emergency:[{from:2028,kind:'amount',value:15000,sized:{pct:.05,basis:'net'}}],bogus:[{from:2027,kind:'amount',value:1}],dining:[{from:'x',kind:'amount',value:1},{from:2031,kind:'wat',value:1}]},
  livingGroceriesY9:30000,savingEmergencyY2:9000,
  planItems:[{label:'Camp',category:'entertainment',from:2032,to:2039,amount:8000,grow:true},{label:'Gear',category:'oneoff',from:2027,to:2027,amount:6000,grow:false}]});
 it('lists every rule, pin and plan item, line by line and oldest first, and ignores what is malformed',()=>{
  const o=B.overrides(P0);
  expect(o.map(x=>x.type+':'+x.category+':'+x.from)).toEqual([
   // each line's changes run oldest to newest, so the list reads as that line's history
   'rule:groceries:2027','rule:groceries:2030','pin:groceries:2035','rule:groceries:2040',
   'item:entertainment:2032','rule:emergency:2028','pin:emergency:2028','item:oneoff:2027']);
  expect(B.overrides(plan()).length).toBe(0);
 });
 it('says where each rule ends: at the next one, or at the end of the plan',()=>{
  const g=B.overrides(P0).filter(x=>x.type==='rule'&&x.category==='groceries');
  expect(g.map(x=>[x.from,x.to])).toEqual([[2027,2029],[2030,2039],[2040,2058]]);
  expect(g.map(x=>x.ref)).toEqual([1,0,2]);                     // the position in the stored list, for removal
 });
 it('writes one plain sentence for each kind',()=>{
  const t=o=>B.overrideText(P0,o,f);const o=B.overrides(P0);
  expect(t(o.find(x=>x.type==='rule'&&x.from===2027))).toBe('5% of net income, every year');
  expect(t(o.find(x=>x.type==='rule'&&x.from===2030))).toBe('$20,000 a year in 2030, then rising with inflation');
  expect(t(o.find(x=>x.type==='rule'&&x.from===2040))).toBe("back to the model's figure");
  expect(t(o.find(x=>x.type==='rule'&&x.category==='emergency'))).toBe('$15,000 a year in 2028, then rising with inflation (sized from 5% of net income)');
  expect(t(o.find(x=>x.type==='pin'&&x.category==='groceries'))).toBe('$30,000 a year, for 2035 only');
  expect(t(o.find(x=>x.type==='item'&&x.label==='Camp'))).toBe('Camp: $8,000 a year, growing with inflation');
  expect(t(o.find(x=>x.type==='item'&&x.label==='Gear'))).toBe('Gear: $6,000 once');
 });
 it('does not touch the plan',()=>{
  const snap=JSON.stringify(P0);B.overrides(P0);expect(JSON.stringify(P0)).toBe(snap);
 });
});

// The Budget page is built top to bottom from `const`s. Using one before the line that defines it throws and
// blanks the whole tab, and unit tests of the pure functions cannot see it — it has happened twice. This reads
// the render function and checks every name used is defined above where it is first used.
describe('the Budget render defines what it uses before it uses it',()=>{
 const src=html.slice(html.indexOf('function renderBudgetTab('));
 // Comments are prose, and a comment that says "the groups" is not a use of `groups`.
 const body=src.slice(0,src.indexOf('\n}\n')).replace(/(^|\s)\/\/[^\n]*/g,'$1');
 const defs=[...body.matchAll(/^  const (\w+)\s*=/gm)].map(m=>({name:m[1],at:m.index}));
 it('has every top-level const defined before any later template or statement mentions it',()=>{
  const late=[];
  for(const d of defs){
   if(d.name.length<2)continue;                                    // single letters are parameters almost everywhere
   const re=new RegExp('(?<![\\w.$\'"`])'+d.name+'(?![\\w$\'"`:])','g');   // not a property, a string, or an object key
   let m;while((m=re.exec(body))){
    if(m.index<d.at){
     // A mention before the definition: only fine inside a nested function that runs later. Check it is not at the top level.
     const before=body.slice(0,m.index);
     const depthFn=(before.match(/=>\s*[\{`(]|function\s*\w*\(/g)||[]).length;
     const line=before.slice(before.lastIndexOf('\n')+1);
     if(/^  (const|let|h\+=)/.test(line)||/^  \w/.test(line))late.push(d.name+' used at '+m.index+' before it is defined at '+d.at);
    }
   }
  }
  expect([...new Set(late)]).toEqual([]);
 });
});

describe('changes over time on the Budget screen',()=>{
 const ui=html.slice(html.indexOf('let _budgetYear='),html.indexOf('function renderSpendingTab('));
 it('puts a chip under each changed line for every rule and pin, that jumps to its year',()=>{
  expect(ui).toContain('const changeChips=k=>{');
  expect(ui).toContain('onclick="budgetYearSet(${o.from})"');
  expect(ui).toContain("${actualStrip(k,value,o.readonly)}${changeChips(k)}");
  expect(ui).toContain('const allOv=B.overrides(P);');
 });
 it('lists everything changed in one fold, by line, with a way to remove each',()=>{
  expect(ui).toContain("Everything you've changed · ${allOv.length}");
  expect(ui).toContain("budgetRemoveOverride('${o.type}','${o.category}'");
  expect(ui).toContain("bdFold('ledger')");
 });
 it('removes a rule, a pin or an item as an ordinary undoable change',()=>{
  const fn=html.slice(html.indexOf('function budgetRemoveOverride('),html.indexOf('\n}\n',html.indexOf('function budgetRemoveOverride('))+3);
  expect(fn).toContain('budgetChange(');expect(fn).toContain('budgetRemoveItem(');
  expect(fn).toContain('segs.splice(Number(ref),1)');
 });
});

describe('call-outs for a whole group, and the bottom line',()=>{
 const R0=M.run(plan()).R;
 const withSpend=(over)=>{const P=plan(over);return {P,R:M.run(P).R}};
 it('flags fixed costs above the usual range, and below it, and says nothing in between',()=>{
  const {P,R}=withSpend();
  expect(B.groupChecks(P,R,2031).fixed).toMatchObject({status:'high'});
  expect(B.groupChecks(P,R,2031).fixed.text).toContain('above the usual 50–60%');
  // Crafted rows: fixed costs set to an exact share of net income, nothing else in the group.
  const at=share=>R.map(r=>r.yr===2031?{...r,hFull:share*r.netTC,ccFull:0,tuFull:0,livFullParts:{}}:r);
  expect(B.groupChecks(P,at(.75),2031).fixed).toMatchObject({status:'high'});
  expect(B.groupChecks(P,at(.55),2031).fixed).toBeUndefined();
  expect(B.groupChecks(P,at(.40),2031).fixed).toBeUndefined();
  expect(B.groupChecks(P,at(.20),2031).fixed).toMatchObject({status:'low'});
  expect(B.groupChecks(P,at(.20),2031).fixed.text).toContain('below the usual 50–60%');
 });
 it('flags discretionary spending above or below its usual range',()=>{
  const {P,R}=withSpend({budgetRules:{dining:[{from:2026,kind:'amount',value:90000}]}});
  const c=B.groupChecks(P,R,2030).discretionary;
  expect(c).toMatchObject({status:'high'});expect(c.text).toContain('20–35%');
  const lean=withSpend({budgetRules:Object.fromEntries(['dining','shopping','vacations','entertainment','misc','charity','clothing'].map(k=>[k,[{from:2026,kind:'amount',value:500}]]))});
  expect(B.groupChecks(lean.P,lean.R,2030).discretionary).toMatchObject({status:'low'});
 });
 it('flags housing against the share of gross income lenders look at',()=>{
  const {P,R}=withSpend({nycRent:30000,rentCap:60000,housingMode:'rent'});
  const c=B.groupChecks(P,R,2027).housing;
  expect(c).toMatchObject({status:'high'});expect(c.text).toContain('28%');
  expect(B.groupChecks(plan(),R0,2027).housing).toBeUndefined();
 });
 it('says when a year spends more than it takes in, and whether the plan meant it',()=>{
  const P=plan(),R=M.run(P).R,deficit=R.find(r=>r.flowFull<-10000);
  const c=B.groupChecks(P,R,deficit.yr).bottom;
  expect(c.status).toBe('draw');expect(c.text).toContain('more than it takes in');
  expect(c.text).toContain('by design');            // the plan itself runs a drawing-down stretch there
  expect(B.groupChecks(P,R,2027).bottom).toBeUndefined();
 });
 it('flags too little left to save, but never in a deficit year (that is the bottom line\'s job)',()=>{
  const P=plan(),R=M.run(P).R;
  const thin=R.find(r=>r.flowFull>0&&r.flowFull/r.netTC<.10);
  expect(thin).toBeTruthy();
  const c=B.groupChecks(P,R,thin.yr);
  expect(c.investing).toMatchObject({status:'low'});expect(c.bottom).toBeUndefined();
  const deficit=R.find(r=>r.flowFull<-1000);
  expect(B.groupChecks(P,R,deficit.yr).investing).toBeUndefined();
 });
 it('flags a reserve floor that covers under three months of fixed costs',()=>{
  const P=plan({liquidReserveFloor:30000}),R=M.run(P).R;
  expect(B.groupChecks(P,R,2030).saving).toMatchObject({status:'low'});
  expect(B.groupChecks(plan(),R0,2030).saving).toBeUndefined();
 });
 it('returns nothing for a year outside the plan, and does not touch the plan',()=>{
  expect(B.groupChecks(plan(),R0,1999)).toEqual({});
  const P=plan(),snap=JSON.stringify(P);B.groupChecks(P,R0,2031);expect(JSON.stringify(P)).toBe(snap);
 });
});

describe('group call-outs and bigger targets on the Budget screen',()=>{
 const ui=html.slice(html.indexOf('let _budgetYear='),html.indexOf('function renderSpendingTab('));
 const css=fs.readFileSync(new URL('../public/ui.css',import.meta.url),'utf8');
 it('shows a call-out under each group and under the bottom line, and a housing one on its row',()=>{
  expect(ui).toContain('const gc=B.groupChecks(P,R,yr);');
  expect(ui).toContain("${callout(gc[b.key])}<div class=\"cl-list\">");
  expect(ui).toContain('${callout(gc.bottom)}</div>`;');
  expect(ui).toContain('if(gc.housing)checkByLine.housing=');
  expect(ui).toContain("c.status==='low'?'Looks light':c.status==='draw'?'Heads up':'Looks high'");
 });
 it('makes the small text and the tap targets larger',()=>{
  expect(css).toContain('.bd-pct{min-height:30px;font-size:13px;width:58px}');
  expect(css).toContain('.bd-tag{font-size:11px;padding:2px 8px}');
  expect(css).toContain('@media(pointer:coarse){.bd-pct{min-height:38px}.bd-link{min-height:40px}');
 });
});

describe('clearer Budget: fewer repeats, honest bars, plain words',()=>{
 const ui=html.slice(html.indexOf('let _budgetYear='),html.indexOf('function renderSpendingTab('));
 it('keeps the shares in the group headers and off the bar legend',()=>{
  expect(ui).toContain("${advEscape(x[1])}</span>`).join('')}</div>`;");
  expect(ui).not.toMatch(/cl-legend">\$\{segsB\.map\([^`]*_lensPct/);
 });
 it('scales each row bar to the biggest line in its own group',()=>{
  expect(ui).toContain('const mx=Math.max(1,...ks.map(k=>living[k])');
  expect(ui).toContain("max:mx||maxLine");
 });
 it('says in words what each scenario-sharing group is',()=>{
  expect(ui).toContain('<dl class="bd-share-key">');
  expect(ui).toContain('PlannerShared.GROUPS.map(g=>`<div><dt>${advEscape(g.label)}</dt><dd>${advEscape(g.note)}</dd></div>`)');
 });
 it('gives a $0 brokerage row its reason, and keeps the savings note short and plain',()=>{
  expect(ui).toContain("surplus is vested Stripe shares, which the plan keeps as shares");
  expect(ui).toContain("Nothing is left over in ${yr}");
  expect(ui).toContain('Not set, so nothing is added.');
  expect(ui).toContain('would mean selling Stripe shares you would otherwise keep');
 });
});

describe('year by year grid',()=>{
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 it('is a fold built only when opened, with year headings that go to that year',()=>{
  expect(html).toContain('function budgetGridHtml(R,yr,allOv,series,mo)');
  expect(html).toMatch(/bdFold\('grid'\)[\s\S]*_bdFolds\.has\('grid'\)\?/);
  expect(html).toContain('onclick="budgetYearSet(${r.yr})"');
  expect(html).toMatch(/\$\{gridFold\}\$\{overTimeHtml\}/);
 });
 it('opening it redraws once, not forever',()=>{
  expect(html).toMatch(/const had=_bdFolds\.has\(k\)[\s\S]*k==='grid'&&open&&!had/);
 });
});

describe('rent set from the Budget honours the scope',()=>{
 const base=plan();
 const rents=p=>M.run(p).R.map(r=>[r.yr,r.hFull]);
 const first=rents(base).filter(([y])=>y<base.homePurchaseYear);
 it('a one-year figure changes that year and no other',()=>{
  const y=first[2][0];
  const after=rents({...base,rentSteps:[{from:y,monthly:9000,only:true}]});
  for(const [yr,h] of after){
   const was=rents(base).find(a=>a[0]===yr)[1];
   if(yr===y)expect(h).toBe(Math.round(108000*(1+base.rentInflation)**(yr-y)));else expect(h).toBe(was);
  }
 });
 it('a from-this-year figure leaves earlier years alone and moves later ones',()=>{
  const y=first[2][0];
  const after=rents({...base,rentSteps:[{from:y,monthly:9000}]}),was=rents(base);
  for(const [yr,h] of after){
   const w=was.find(a=>a[0]===yr)[1];
   if(yr<y)expect(h).toBe(w);else if(yr<base.homePurchaseYear)expect(h).toBe(Math.round(108000*(1+base.rentInflation)**(yr-y)));
  }
 });
});

describe('Stripe compensation: back to the assumptions for the later years',()=>{
 const ui=fs.readFileSync(new URL('../public/stripe-grants-ui.js',import.meta.url),'utf8');
 it('offers a reset only while typed figures exist, and undo after',()=>{
  expect(ui).toContain('function stripeManualClear()');
  expect(ui).toContain('delete P.stripeManualLater');
  expect(ui).toMatch(/Object\.keys\(P\.stripeManualLater\|\|\{\}\)\.length\?[\s\S]*stripeManualClear\(\)[\s\S]*_laterBackup\?[\s\S]*stripeManualRestore\(\)/);
 });
 it('clearing the typed years returns the model to its growth formula',()=>{
  const typed=M.run(plan({stripeManualLater:{2037:{cash:900000,stock:900000}}})).R;
  const clean=M.run(plan({})).R;
  expect(M.normComp(plan({stripeManualLater:{2037:{cash:900000,stock:900000}}}),11).cash).toBe(900000);
  expect(M.normComp(plan({}),11).cash).not.toBe(900000);
  expect(typed.find(r=>r.yr===2037).netTC).not.toBe(clean.find(r=>r.yr===2037).netTC);
 });
});
