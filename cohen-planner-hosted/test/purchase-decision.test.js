import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import M from '../public/model.js';
import Dn from '../public/purchase-decision.js';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const defaults=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const plan={homePurchaseYear:2031,liquidReserveFloor:500000,costBasisPct:1};
const prior={yr:2030,liq:800000,sEnd:100000,sBasis:100000}, buy={yr:2031,sAvailable:160000,totEFull:100000,sVestRate:.5,capGainsRate:.3,liq:1000};
const check=(changes={},o={},row=buy)=>Dn.closing({...plan,...changes},[prior,row],{quarter:2,need:470000,...o});
describe('dated purchase sources',()=>{
 it('keeps the reserve and covers the need once, reporting the remaining gap',()=>{
  const a=check(),b=check({},{manualElection:true});
  expect(a.portfolio).toBe(300000);expect(a.shares).toBe(100000);expect(a.elective).toBe(0);
  expect(b.elective).toBe(20000);expect(b.shortfall).toBe(50000);expect(b.used+b.usedElection+b.usedSales+b.shortfall).toBe(b.need);
  const c=check({stripeLiquidityFromYear:2031},{manualElection:true});
  expect(c.shares+c.elective).toBe(180000);expect(c.used+c.usedSales+c.usedElection).toBe(470000);
 });
 it('uses dated grant cash once; an interruption blocks share sales and delayed tenders miss a Q2 close',()=>{
  const s=check({},{stress:true}, {...buy,qcaNetQuarters:[500,600,700,800],sVestByQuarter:[110,220,330,440]});
  expect(s.shares).toBe(0);expect(s.elective).toBe(1100);
  expect(check({}, {}, {...buy,stripeSalesBlocked:true}).shares).toBe(0);
 });
 it('uses actual modeled taxes and does not treat below-floor assets as available',()=>{
  expect(check({costBasisPct:.5}).portfolio).toBe(255000);
  expect(check({liquidReserveFloor:900000}).portfolio).toBe(0);
  expect(check({}, {pause:6}).portfolio).toBe(250000);
 });
});
describe.each(['deal','brooklyn'])('selected purchase in %s',mode=>{
 it('reconciles family costs, finds the lowest reserve after buying, and never writes to the plan',()=>{
  const p={...defaults,housingMode:'buy',numKids:4,homePurchaseYear:2031,locationConfig:{mode,moveYear:2031}},before=JSON.stringify(p);
  const rows=M.run(p).R,years=M.housingYears(p,rows,.25),f=Dn.closing(p,rows,{quarter:2,need:M.cashToClose(p.homePrice,p).total}),d=Dn.assess(p,rows,years,f);
  for(const r of rows){expect(r.childEducation.reduce((a,c)=>a+c.care,0)).toBe(r.ccFull);expect(r.childEducation.reduce((a,c)=>a+c.tuition,0)).toBe(r.tuFull);}
  expect(d.low.liq).toBe(Math.min(...rows.filter(r=>r.yr>=2031).map(r=>r.liq)));
  expect(d.tight.flowFull).toBe(Math.min(...d.owned.map(r=>r.flowFull)));expect(JSON.stringify(p)).toBe(before);
 });
});

it('keeps the same peak pressure year when a purchase preview moves the tightest year',()=>{
 const base=[{yr:2030,flowFull:-1000,netWorth:10},{yr:2031,flowFull:-20,netWorth:100},{yr:2032,flowFull:-10,netWorth:200}];
 const preview=[{yr:2031,flowFull:20,netWorth:90},{yr:2032,flowFull:-100,netWorth:250}];
 expect(Dn.peakImpact(base,preview,2031)).toMatchObject({year:2031,flowDelta:40,wealthDelta:-10});
});
