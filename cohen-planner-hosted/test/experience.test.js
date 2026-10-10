import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import Suggest from '../public/suggest.js';
function presentation(){
 const P={planStartYear:2026,expenseInflation:.03,numKids:0,housingMode:'rent',planItems:[]};
 const ctx={P,SUB_VIEWS:{projection:{views:[]}},MORE_ACTIONS:[],_planLoaded:false,afParams(){},PlannerSuggest:Suggest,PlannerTime:{year:()=>2026},LIV_LABEL:{groceries:'Groceries',clothing:'Clothing'},UI:{escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),money:v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(v)},render(){},renderHomeTab(){},renderCompareTab(){},deflate:v=>v,_reduceMotion:()=>true};
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
