import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),M=require('../public/model.js'),S=require('../public/shared-lines.js'),G=require('../public/stripe-grants.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const groups=Object.fromEntries(S.GROUPS.map(g=>[g.key,g.key!=='housing']));
const plan=o=>({...D,observedOn:null,sharedLines:{groups},nycFamilyBudget:true,baseGroceries:14400,baseShopping:12000,clothingShare:.4,...o});
describe('one NYC household budget',()=>{
 it('keeps every non-housing dollar identical across cases with different housing, income, family and inflation inputs',()=>{
  const live=plan({housingMode:'rent',expenseAdjY4:1234,planItems:[{category:'oneoff',from:2030,to:2030,amount:5000},{category:'misc',from:2029,to:2034,amount:1000}],budgetRules:{medical:[{from:2026,kind:'pct',value:.01,basis:'gross'}]}});
  live.sharedBudgetIncome=Object.fromEntries(M.run(live).R.map(r=>[r.yr,{gross:r.gross,net:r.netTC}]));
  const changed=S.attach({...D,housingMode:'buy',homePurchaseYear:2028,numKids:1,kid1Birth:2038,expenseInflation:.07,normGrowth:.1,combinedIncomeCap:400000,expenseAdjY4:99999,planItems:[{category:'oneoff',from:2030,to:2030,amount:9876}]},live);
  const a=M.run(live).R,b=M.run(changed).R;
  for(let i=0;i<a.length;i++){
    expect(b[i].livFullParts).toEqual(a[i].livFullParts);
    expect(b[i].ccFull).toBe(a[i].ccFull);expect(b[i].tuFull).toBe(a[i].tuFull);
    expect(b[i].totEFull-b[i].hFull).toBe(a[i].totEFull-a[i].hFull);
  }
  expect(a[10].hFull).not.toBe(b[10].hFull);
  expect(M.run(S.attach(S.strip(changed),live)).R).toEqual(b);
 });
 it('adds age-based food, goods and clothing separately, inflates childcare, and ends dependent costs at 22',()=>{
  const p=plan({numKids:1,kid1Birth:2026,expenseInflation:.03,planEndYear:2050});
  const rows=M.run(p).R;
  expect(rows[0].livFullParts.groceries).toBe(16200);
  expect(rows[0].livFullParts.shopping).toBe(8400);
  expect(rows[0].livFullParts.clothing).toBe(5400);
  expect(rows[1].ccFull).toBeCloseTo(p.childcareMonthly*12*1.03);
  expect(rows[22].livFullParts.groceries).toBe(Math.round(14400*1.03**22));
  expect(M.nycKidCost(13).g).toBe(5100);expect(M.nycKidCost(18).g).toBe(2550);
 });
 it('caps future total compensation without raising low years or changing the budget',()=>{
  const p=plan({combinedIncomeCap:750000,normGrowth:.12,normStockGrowth:.12});
  const capped=M.run(p).R,raw=M.run({...p,combinedIncomeCap:0}).R;
  expect(capped.some(r=>r.gross===750000)).toBe(true);
  for(let i=0;i<capped.length;i++){
    expect(capped[i].gross).toBe(Math.min(750000,raw[i].gross));
    expect(capped[i].livFullParts).toEqual(raw[i].livFullParts);
  }
 });
 it('scales grant cash, stock, market value and shares consistently without mutating the ledger',()=>{
  const p=plan({planEndYear:2028,combinedIncomeCap:400000,observedOn:'2026-08-01'});
  p.stripeGrants={...G.setup(p),enabled:true,throughYear:null,referenceTender:100,reference409a:100,referenceValuation:100e9,defaultARG:300000,defaultPEG:100000};
  const ledger=G.compile(p),before=JSON.stringify(ledger),a=M.run(p).R,b=M.run({...p,combinedIncomeCap:0}).R;
  for(let i=0;i<a.length;i++){
    expect(a[i].gross).toBeLessThanOrEqual(400000);
    const f=a[i].sGrantDetails.incomeCapScale;
    expect(a[i].sGrantDetails.stock).toBeCloseTo(b[i].sGrantDetails.stock*f);
    expect(a[i].sGrantDetails.market).toBeCloseTo(b[i].sGrantDetails.market*f);
    expect(a[i].sGrantDetails.events.reduce((s,e)=>s+e.shares,0)).toBeCloseTo(a[i].sVestingShares);
  }
  expect(JSON.stringify(ledger)).toBe(before);
 });
});
