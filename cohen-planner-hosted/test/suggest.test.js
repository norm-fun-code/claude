import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const S=require('../public/suggest.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const plan=(o)=>({...D,planStartYear:2026,observedOn:null,...o});
const rows=(o)=>M.run(plan(o)).R;
const at=(R,y)=>R.find(r=>r.yr===y);
const base=rows();

describe('plan items in the model',()=>{
 it('change nothing when there are none',()=>{
  expect(M.run(plan({planItems:[]}))).toEqual(M.run(plan()));
 });
 it('a one-off lands in the one-off column, in its year only, not inflated',()=>{
  const R=rows({planItems:[{category:'oneoff',from:2030,to:2030,amount:30000,grow:false}]});
  expect(at(R,2030).totEFull-at(base,2030).totEFull).toBe(30000);
  expect(at(R,2030).eAdj-at(base,2030).eAdj).toBe(30000);
  expect(at(R,2031).totEFull).toBe(at(base,2031).totEFull);
 });
 it('a recurring item adds to its line for the years it covers and grows with inflation',()=>{
  const R=rows({planItems:[{category:'entertainment',from:2032,to:2034,amount:8000,grow:true}]});
  expect(at(R,2031).livFullParts.entertainment).toBe(at(base,2031).livFullParts.entertainment);
  expect(at(R,2032).livFullParts.entertainment-at(base,2032).livFullParts.entertainment).toBe(8000);
  expect(at(R,2034).livFullParts.entertainment-at(base,2034).livFullParts.entertainment).toBe(Math.round(8000*1.03**2));
  expect(at(R,2035).livFullParts.entertainment).toBe(at(base,2035).livFullParts.entertainment);
  expect(at(R,2033).livAdds.entertainment).toBe(Math.round(8000*1.03));
 });
 it('sits on top of a rule or a pin rather than being swallowed by it',()=>{
  const R=rows({budgetRules:{entertainment:[{from:2027,kind:'amount',value:5000}]},livingEntertainmentY6:7000,
    planItems:[{category:'entertainment',from:2032,to:2033,amount:1000,grow:false}]});
  expect(at(R,2032).livFullParts.entertainment).toBe(8000);   // pin 7000 + item 1000
  expect(at(R,2033).livFullParts.entertainment).toBe(Math.round(5000*1.03**6)+1000);
 });
 it('keeps the total equal to the sum of its parts, and ignores a malformed item',()=>{
  const R=rows({planItems:[{category:'groceries',from:2030,to:2031,amount:3333.3,grow:true},{category:'x',from:'a',to:2,amount:5},null]});
  for(const r of R)expect(r.totEFull).toBe(r.hFull+Object.values(r.livFullParts).reduce((t,v)=>t+v,0)+r.ccFull+r.tuFull+r.eAdj);
  expect(at(R,2040).totEFull).toBe(at(base,2040).totEFull);
 });
 it('raises the cost of a plan: less headroom with the item than without',()=>{
  const B=require('../public/budget.js');
  const a=B.headroom(plan(),M.run,2027).ongoing.value;
  const b=B.headroom(plan({planItems:[{category:'oneoff',from:2040,to:2040,amount:300000,grow:false}]}),M.run,2027).ongoing.value;
  expect(b).toBeLessThan(a);
 });
});

describe('suggestions',()=>{
 it('read the plan\'s own events: birth, camp, 13th birthday, the house',()=>{
  const all=S.events(plan(),2026,40).map(e=>e.id);
  expect(all).toEqual(expect.arrayContaining(['baby-gear-1-2027','camp-1-2027','mitzvah-1-2027','home-furnish-2030','home-upkeep-2030']));
  const e=Object.fromEntries(S.events(plan(),2026,40).map(e=>[e.id,e]));
  expect(e['camp-1-2027'].year).toBe(2032);
  expect(e['camp-1-2027'].item).toMatchObject({from:2032,to:2039,category:'entertainment',grow:true});
  expect(e['mitzvah-1-2027'].year).toBe(2040);
  expect(e['home-furnish-2030'].item.amount).toBe(30000);
 });
 it('only look a couple of years ahead of the year in view',()=>{
  expect(S.events(plan(),2028).map(e=>e.year).every(y=>y>=2028&&y<=2030)).toBe(true);
 });
 it('make no house suggestions for a renter, and one child per child that exists',()=>{
  const ids=S.events(plan({housingMode:'rent'}),2026,40).map(e=>e.id);
  expect(ids.some(i=>i.startsWith('home-'))).toBe(false);
  const one=S.events(plan({numKids:1}),2026,40).map(e=>e.id).filter(i=>i.startsWith('baby'));
  expect(one).toEqual(['baby-gear-1-2027']);
 });
 it('stop suggesting what has been added or dismissed',()=>{
  const p=plan({budgetDismissed:['camp-1-2027'],planItems:[{sid:'baby-gear-1-2027',category:'oneoff',from:2027,to:2027,amount:6000}]});
  const ids=S.pending(p,2026,40).map(e=>e.id);
  expect(ids).not.toContain('camp-1-2027');expect(ids).not.toContain('baby-gear-1-2027');
  expect(ids).toContain('mitzvah-1-2027');
 });
 it('flag light home upkeep, and stop when it is enough',()=>{
  expect(S.events(plan(),2030).some(e=>e.id==='home-upkeep-2030')).toBe(true);
  expect(S.events(plan({maintBase:20000}),2030).some(e=>e.id==='home-upkeep-2030')).toBe(false);
  const e=S.events(plan(),2030).find(e=>e.id==='home-upkeep-2030');
  expect(e.param).toMatchObject({key:'maintBase',value:20000});
 });
 it('checks a line against the household, and is quiet when it is in range',()=>{
  const lean=plan({budgetRules:{groceries:[{from:2026,kind:'amount',value:4000}]}});
  const c=S.checks(lean,M.run(lean).R,2030).find(c=>c.line==='groceries');
  expect(c.status).toBe('low');expect(c.text).toContain('2 adults and 2 children');
  const inRange=plan({budgetRules:{groceries:[{from:2026,kind:'amount',value:16000}],clothing:[{from:2026,kind:'amount',value:6000}],medical:[{from:2026,kind:'amount',value:9000}]}});
  expect(S.checks(inRange,M.run(inRange).R,2030)).toEqual([]);
 });
 it('counts a child as part of a person by age, and never counts one before they are born',()=>{
  expect(S.people(plan(),2026)).toBe(2);
  expect(S.people(plan(),2027)).toBeCloseTo(2.3,5);
  expect(S.people(plan(),2045)).toBeGreaterThan(S.people(plan(),2027));
  expect(S.household(plan(),2026)).toBe('2 adults');
 });
});

describe('suggestions on the Budget screen',()=>{
 const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const ui=html.slice(html.indexOf('let _budgetYear='),html.indexOf('function renderSpendingTab('));
 it('is served and loaded, and nothing changes until it is accepted',()=>{
  expect(html).toContain('<script src="/suggest.js"></script>');
  expect(server).toContain("'suggest.js'");
  const add=ui.slice(ui.indexOf('function budgetAddItem('),ui.indexOf('function budgetDismiss('));
  expect(add).toContain('budgetChange(');
  expect(ui.slice(ui.indexOf('function renderBudgetTab('))).toContain('PlannerSuggest.pending(P,yr,2)');
 });
 it('every change here can be undone, and a removed item is not offered straight back',()=>{
  const remove=ui.slice(ui.indexOf('function budgetRemoveItem('),ui.indexOf('function budgetItemAmount('));
  expect(remove).toContain('budgetDismissed');
  expect(ui).toMatch(/function budgetChange\(label,before,mutate\)\{\s*_budgetUndo=/);
 });
 it('says what a check is and is not',()=>{
  const src=fs.readFileSync(new URL('../public/suggest.js',import.meta.url),'utf8');
  expect(src).toContain('rule of thumb');
  expect(src.replace(/\s*\n\/\/\s*/g,' ')).toContain('never to answer one');
 });
});
