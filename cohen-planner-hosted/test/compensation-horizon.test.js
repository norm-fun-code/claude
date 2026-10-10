import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import M from '../public/model.js';
import PM from '../public/plan-migrate.js';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=new Function('return ('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')')();
const plan=extra=>({...D,observedOn:null,housingMode:'rent',...extra});
describe('annual compensation horizons',()=>{
 it('uses growth from the last editable year and ignores retained later overrides',()=>{
  const p=plan({normManualThroughYear:2037,normGrowth:.03,normStockGrowth:.05,stripeManualLater:{2037:{cash:400000,stock:200000},2040:{cash:1,stock:1}}});
  const before=JSON.stringify(p);
  expect(M.normComp(p,11)).toEqual({cash:400000,stock:200000});
  expect(M.normComp(p,12).cash).toBeCloseTo(412000);
  expect(M.normComp(p,12).stock).toBeCloseTo(210000);
  expect(M.normComp(p,14).cash).toBeCloseTo(400000*1.03**3);
  expect(JSON.stringify(p)).toBe(before);
 });
 it('uses all five W2 years before a 2031 practice start and starts practice in 2031',()=>{
  const p=plan({nancyRampYear:2031,nancyW2Y4:175000,nancyRampClients:4,nancyHourlyRate:300,nancyWeeksPerYear:46});
  const rows=M.run(p).R;
  expect(rows.find(r=>r.yr===2030).nancyG).toBe(175000);
  expect(rows.find(r=>r.yr===2031).nancyG).toBe(4*300*46);
 });
 it('starts practice in 2026 or 2027 without consuming later W2 inputs',()=>{
  for(const year of [2026,2027]){
   const p=plan({nancyRampYear:year,nancyW2Y0:120000,nancyW2Y1:180000,nancyRampClients:4,nancyHourlyRate:300,nancyWeeksPerYear:46});
   const rows=M.run(p).R;
   expect(rows.find(r=>r.yr===year).nancyG).toBe(55200);
   if(year===2027)expect(rows[0].nancyG).toBe(120000);
  }
 });
 it('keeps extra annual income values attached to their calendar years on roll-forward',()=>{
  const p=plan({nancyRampYear:2032,nancyW2Y4:175000,nancyW2Y5:190000});
  const q=PM.rollForwardParams(p);
  expect(M.run(q).R.find(r=>r.yr===2030).nancyG).toBe(175000);
  expect(M.run(q).R.find(r=>r.yr===2031).nancyG).toBe(190000);
 });
 it('carries the last W2 entry into newly exposed years, including an explicit zero',()=>{
  expect(M.nancyW2Income(plan({nancyW2Y3:145000}),4)).toBe(145000);
  expect(M.nancyW2Income(plan({nancyW2Y4:0}),5)).toBe(0);
 });
});
