import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const Decisions=require('../public/decisions.js');
const Advisor=require('../public/advisor-tools.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const plan={...D,observedOn:null,planStartYear:2026,planEndYear:2045,homePurchaseYear:2030};
describe('rent versus buy',()=>{
 it('preserves legacy buy projections and ignores rental inflation in buy mode',()=>{
  const legacy={...plan};delete legacy.housingMode;delete legacy.rentInflation;
  expect(M.run(plan)).toEqual(M.run(legacy));
  expect(M.run({...plan,rentInflation:.09})).toEqual(M.run(plan));
 });
 it('compounds rent through peak years without purchase costs or equity',()=>{
  const p={...plan,housingMode:'rent',nycRent:6000,rentInflation:.03};
  const {R}=M.run(p);
  for(const r of R){
   expect(r.hFull).toBe(Math.round(72000*1.03**(r.yr-2026)));
   expect(r.dpOut).toBe(0);expect(r.hv).toBe(0);expect(r.ptax).toBe(0);
  }
  expect(Decisions.summarize(p,R,2026).purchase).toBe(null);
  expect(Decisions.milestones(p,R).some(e=>e.kind==='home')).toBe(false);
  expect(M.runMonteCarlo(p,5).dpFailPct).toBe(null);
 });
 it('makes unused purchase assumptions irrelevant to rent including taxes',()=>{
  const p={...plan,housingMode:'rent'};
  expect(M.run(p)).toEqual(M.run({...p,homePrice:4000000,homePurchaseYear:2027,downPctg:20,mortgageRate:9,homeAppreciation:.08,propTaxRate:.04}));
 });
 it('supports flat rent and validates advisor housing choices',()=>{
  expect(M.run({...plan,housingMode:'rent',rentInflation:0}).R.every(r=>r.hFull===plan.nycRent*12)).toBe(true);
  expect(Advisor.validateOverride('housingMode','rent').ok).toBe(true);
  expect(Advisor.validateOverride('housingMode','other').ok).toBe(false);
  expect(Advisor.validateOverride('rentInflation',.04).ok).toBe(true);
 });
});
it('renders rental housing controls and projected rent without purchase charts',()=>{
 const elements={chartArea:{innerHTML:''}};
 const p={...plan,housingMode:'rent',rentInflation:.04};
 const context=vm.createContext({P:p,document:{getElementById:id=>elements[id]},destroyCharts(){},fmtF:v=>String(v)});
 const control=html.slice(html.indexOf('function housingModeControl'),html.indexOf('function USel'));
 const render=html.slice(html.indexOf('function renderHousingTab'),html.indexOf('function updateRefiCalc'));
 vm.runInContext(control+render,context);
 context.renderHousingTab(M.run(p).R,p);
 expect(elements.chartArea.innerHTML).toContain('aria-pressed="true"');
 expect(elements.chartArea.innerHTML).toContain('Annual rent inflation (%)');
 expect(elements.chartArea.innerHTML).toContain('value="4.0"');
 expect(elements.chartArea.innerHTML).toContain('2045');
 expect(elements.chartArea.innerHTML).not.toContain('NaN');
});
