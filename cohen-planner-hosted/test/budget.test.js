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
 it('sort every line into exactly one group, and an unknown one lands in discretionary',()=>{
  const all=B.BUCKETS.flatMap(b=>b.lines);
  expect(new Set(all).size).toBe(all.length);
  for(const k of M.LIV_KEYS)expect(B.BUCKETS.some(b=>b.lines.includes(k))).toBe(true);
  expect(B.bucketOf('insurance')).toBe('fixed');expect(B.bucketOf('groceries')).toBe('essential');
  expect(B.bucketOf('vacations')).toBe('discretionary');expect(B.bucketOf('charity')).toBe('discretionary');
  expect(B.bucketOf('pets')).toBe('discretionary');
  expect(B.BUCKETS.find(b=>b.key==='investing').lines).toEqual([]);expect(B.BUCKETS.find(b=>b.key==='saving').lines).toEqual([]);
 });
 it('runs fixed, essentials, discretionary, then savings, then investing',()=>{
  expect(B.BUCKETS.map(b=>b.key)).toEqual(['fixed','essential','discretionary','saving','investing']);
  expect(B.BUCKETS.filter(b=>b.computed).map(b=>b.key)).toEqual(['saving','investing']);
 });
 it('split a surplus into Stripe kept, portfolio and reserve, adding to the excess exactly',()=>{
  for(const r of R){
   const a=B.allocation(P,R,r.yr);
   expect(a.investing.stripe+a.investing.portfolio+a.saving.reserve).toBeGreaterThanOrEqual(a.excess-2);
   expect(a.investing.stripe+a.investing.portfolio+a.saving.reserve).toBeLessThanOrEqual(a.excess+2);
   expect(a.excess*a.deficit).toBe(0);
   expect(a.investing.stripe).toBeLessThanOrEqual(Math.max(0,r.sRet||0)+1);
  }
 });
 it('says drawing down when the year runs a deficit, with nothing invested',()=>{
  const r=R.find(r=>r.flowFull<-1000),a=B.allocation(P,R,r.yr);
  expect(a.deficit).toBe(-r.flowFull);expect(a.investing.total).toBe(0);expect(a.saving.total).toBe(0);
 });
 it('tops up the cash reserve first when it is below its floor',()=>{
  const low=plan({liquidReserveFloor:2000000}),RL=M.run(low).R,a=B.allocation(low,RL,2026);
  expect(a.reserveFunded).toBe(false);
  expect(a.saving.reserveGap).toBeGreaterThan(0);
  expect(a.saving.reserve).toBe(Math.min(a.excess-a.investing.stripe,a.saving.reserveGap));
 });
 it('states the reserve in months of fixed costs, and the 401(k) as outside the surplus',()=>{
  const a=B.allocation(P,R,2030);
  expect(a.reserveMonths).toBeCloseTo(P.liquidReserveFloor/a.fixedPerMonth,0);
  expect(a.investing.k401).toBe(P.pretax401k);
 });
 it('does not change the projection, and covers every year once',()=>{
  const before=JSON.stringify(M.run(P).R);B.allocationSeries(P,R);expect(JSON.stringify(M.run(P).R)).toBe(before);
  expect(B.allocationSeries(P,R).map(a=>a.year)).toEqual(R.map(r=>r.yr));
  expect(B.allocation(P,R,1999)).toBe(null);
 });
});

describe('the groups on the Budget screen',()=>{
 const ui=html.slice(html.indexOf('let _budgetYear='),html.indexOf('function renderSpendingTab('));
 it('groups lines as fixed, essentials and discretionary, then savings and investing',()=>{
  expect(ui).toContain('B.BUCKETS.map(b=>{');
  expect(ui).toContain("Where ${yr}'s money goes");
  expect(ui).not.toContain('Ramit');
  expect(ui).not.toContain('bd-ruler');
 });
 it('makes savings the emergency fund and investing the Fidelity brokerage and Stripe',()=>{
  expect(ui).toContain("computedRow('saving','Emergency fund'");
  expect(ui).toContain("computedRow('investing','Fidelity brokerage'");
  expect(ui).toContain("computedRow('investing','Stripe shares kept'");
  expect(ui).toContain('All the cash left over after the emergency fund');
  expect(ui).toContain('Drawing down');
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
