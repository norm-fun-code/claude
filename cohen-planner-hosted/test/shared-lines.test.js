import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const S=require('../public/shared-lines.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const plan=(o)=>({...D,masterBudget:false,planStartYear:2026,observedOn:null,...o});
const on=(...g)=>({groups:Object.fromEntries(g.map(k=>[k,true]))});
const at=(R,y)=>R.find(r=>r.yr===y);

describe('shared lines',()=>{
 it('are off unless someone turns them on, and housing and discretionary are never recommended',()=>{
  expect(S.config(plan()).any).toBe(false);
  expect(S.config({sharedLines:on('fixed')}).groups).toMatchObject({fixed:true,essential:false,housing:false,choice:false});
  expect(S.GROUPS.filter(g=>g.recommended).map(g=>g.key)).toEqual(['fixed','essential','childcare','tuition']);
  const p=plan({baseGroceries:1});
  expect(S.attach(p,plan({baseGroceries:2}))).toBe(p);              // nothing shared: untouched
  expect(S.strip(p)).toEqual(p);
 });
 it('strip takes the shared groups and the setting out of a scenario, and nothing else',()=>{
  const live=plan({sharedLines:on('essential'),budgetRules:{groceries:[{from:2027,kind:'amount',value:1}],dining:[{from:2027,kind:'amount',value:2}]},
    livingGroceriesY3:5,livingDiningY3:6,planItems:[{category:'groceries',amount:1},{category:'oneoff',amount:2},{category:'dining',amount:3}]});
  const s=S.strip(live);
  expect('baseGroceries' in s).toBe(false);expect('baseMedical' in s).toBe(false);expect('sharedLines' in s).toBe(false);
  expect(s.baseDining).toBe(live.baseDining);
  expect(s.budgetRules).toEqual({dining:[{from:2027,kind:'amount',value:2}]});
  expect('livingGroceriesY3' in s).toBe(false);expect(s.livingDiningY3).toBe(6);
  expect(s.planItems).toEqual([{category:'oneoff',amount:2},{category:'dining',amount:3}]);
  expect(live.baseGroceries).toBeDefined();                          // the source is not mutated
 });
 it('attach brings the shared groups from the live plan and drops the scenario\'s own copies',()=>{
  const live=plan({sharedLines:on('essential'),baseGroceries:20000,baseMedical:9000,budgetRules:{groceries:[{from:2028,kind:'amount',value:3}]},livingGroceriesY2:77,
    planItems:[{category:'medical',from:2030,to:2030,amount:1,sid:'m'}]});
  const scen=plan({baseGroceries:99999,baseDining:1234,livingGroceriesY9:5,livingMedicalY1:6,budgetRules:{groceries:[{from:2026,kind:'amount',value:9}],dining:[{from:2026,kind:'amount',value:8}]},
    planItems:[{category:'groceries',amount:5},{category:'oneoff',amount:7}]});
  const o=S.attach(scen,live);
  expect(o.baseGroceries).toBe(20000);expect(o.baseMedical).toBe(9000);
  expect(o.livingGroceriesY2).toBe(77);expect('livingGroceriesY9' in o).toBe(false);expect('livingMedicalY1' in o).toBe(false);
  expect(o.budgetRules.groceries).toEqual([{from:2028,kind:'amount',value:3}]);
  expect(o.budgetRules.dining).toEqual([{from:2026,kind:'amount',value:8}]);
  expect(o.baseDining).toBe(1234);
  expect(o.planItems.map(i=>i.category).sort()).toEqual(['medical','oneoff']);
  expect(o.sharedLines).toBe(live.sharedLines);
 });
 it('is idempotent, and a stripped scenario attaches back to the plan it came from',()=>{
  const live=plan({sharedLines:on('fixed','essential','childcare','tuition'),baseGroceries:21000,livingAutoY4:12345});
  const once=S.attach(S.strip(live),live);
  expect(S.attach(once,live)).toEqual(once);
  for(const k of ['baseGroceries','baseAuto','childcareMonthly','tuitionInflation','livingAutoY4'])expect(once[k]).toEqual(live[k]);
 });
 it('can freeze one group into a scenario when it stops being shared, without setting the setting',()=>{
  const live=plan({sharedLines:on('essential','choice'),baseGroceries:20000,baseDining:9000});
  const o=S.attach(plan({baseGroceries:1,baseDining:2}),live,['choice']);
  expect(o.baseDining).toBe(9000);expect(o.baseGroceries).toBe(1);expect('sharedLines' in o).toBe(false);
 });
 it('says what a scenario holds that differs, so turning sharing on is never silent',()=>{
  const live=plan({baseGroceries:20000,baseMedical:9000,budgetRules:{medical:[{from:2027,kind:'amount',value:1}]},livingGroceriesY1:5});
  const scen=plan({baseGroceries:24000,baseMedical:9000,livingGroceriesY1:6,planItems:[{category:'groceries',amount:1}]});
  const d=S.differences(scen,live,['essential'],D);
  expect(d.map(x=>x.kind+':'+x.key).sort()).toEqual(['items:items','pins:pins','rules:medical','value:baseGroceries']);
  expect(d.find(x=>x.key==='baseGroceries')).toMatchObject({label:'Groceries',scenario:24000,live:20000});
  expect(S.differences(live,live,['essential','fixed'],D)).toEqual([]);
  expect(S.differences(scen,live,['choice'],D)).toEqual([]);
 });
});

describe('shared lines in a comparison',()=>{
 const A=plan({baseGroceries:20000,baseDining:9000}),B=plan({baseGroceries:30000,baseDining:20000});
 const cfg=on('essential');
 it('make the same bill the same in every scenario, and leave discretionary free',()=>{
  const live={...A,sharedLines:cfg};
  const a=M.run(S.attach(S.strip({...A,sharedLines:cfg}),live)).R,b=M.run(S.attach(S.strip({...B,sharedLines:cfg}),live)).R;
  for(const y of [2027,2035,2045])expect(at(a,y).livFullParts.groceries).toBe(at(b,y).livFullParts.groceries);
  expect(at(a,2030).livFullParts.dining).not.toBe(at(b,2030).livFullParts.dining);
  expect(at(a,2030).livFullParts.groceries).toBe(at(M.run(A).R,2030).livFullParts.groceries);
 });
 it('follow an edit made while looking at another scenario',()=>{
  const live={...B,baseGroceries:25000,sharedLines:cfg};
  const a=M.run(S.attach(S.strip({...A,sharedLines:cfg}),live)).R;
  expect(at(a,2027).livFullParts.groceries).toBe(at(M.run({...A,baseGroceries:25000}).R,2027).livFullParts.groceries);
 });
 it('without sharing, scenarios are exactly as they were',()=>{
  expect(M.run(S.attach(B,A))).toEqual(M.run(B));
 });
});

describe('shared lines in the page',()=>{
 it('is served, loaded, and wired into the one place scenarios are saved and loaded',()=>{
  expect(html).toContain('<script src="/shared-lines.js"></script>');
  expect(server).toContain("'shared-lines.js'");
  const keep=html.slice(html.indexOf('function keepAssumptions('),html.indexOf('function attachObserved('));
  expect(keep).toContain('PlannerShared.strip(');
  const att=html.slice(html.indexOf('function attachObserved('),html.indexOf('// A case\'s assumptions, made runnable'));
  expect(att).toContain('PlannerShared.attach(');
 });
 it('refreshes the saved cases\' results when a shared figure moves, without re-rendering mid-typing',()=>{
  const md=html.slice(html.indexOf('function markDirty('),html.indexOf('function paintUpdateButton('));
  expect(md).toContain('rebuildScenarioResults()');
  expect(md).toMatch(/_homeView==='compare'/);
 });
 it('asks before it overwrites a scenario\'s own figures, and freezes them when sharing stops',()=>{
  const ui=html.slice(html.indexOf('function sharedToggle('),html.indexOf('function renderBudgetTab('));
  expect(ui).toContain('PlannerShared.differences(');
  expect(ui).toContain('showConfirm(');
  expect(ui).toContain('PlannerShared.attach(s.params,P,[key])');
 });
 it('declares what a row\'s tag uses before the tag is built',()=>{
  const row=html.slice(html.indexOf('const line=(k,label,value,src,opts)=>{'),html.indexOf('const living=row.livFullParts'));
  expect(row.indexOf('const shared=')).toBeGreaterThan(-1);
  expect(row.indexOf('const shared=')).toBeLessThan(row.indexOf('const tag='));
  expect(row.indexOf('const chk=')).toBeLessThan(row.indexOf('const tag='));
 });
});
