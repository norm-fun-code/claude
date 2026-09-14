
import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';
const require=createRequire(import.meta.url);
const G=require('../public/stripe-grants.js');
const M=require('../public/model.js');
const PM=require('../public/plan-migrate.js');
const A=require('../public/advisor-tools.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=new Function('return ('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')')();
function plan(){
  const p={...D,planEndYear:2035,observedOn:null,stripeObservedMonth:null,homePurchaseYear:2099,stripePolicy:'retain'};
  p.stripeGrants={...G.setup(p),enabled:true,throughYear:null,referenceTender:100,reference409a:100,defaultPEG:80000};
  return p;
}
describe('hybrid Stripe compensation',()=>{
  it('defaults new setup to two years without changing existing all-year plans',()=>{
    expect(G.setup(D).throughYear).toBe(2027);
    const p=plan();delete p.stripeGrants.throughYear;
    expect(G.usesGrants(p,2058)).toBe(true);
  });
  it('prefills later cash and stock, including older PEGs, without adding those grants twice',()=>{
    const p=plan(),before=M.run(p).R,h=G.prefillManual(p,2027),after=M.run(h).R;
    for(let i=0;i<before.length;i++){
      expect(after[i].normCash).toBe(before[i].normCash);
      expect(after[i].normStock).toBe(before[i].normStock);
      expect(after[i].netWorth).toBe(before[i].netWorth);
    }
    expect(after[2].sGrantDetails.manual).toBe(true);
    expect(after[2].sGrantDetails.events.length).toBe(4);
    expect(p.stripeGrants.manualComp[2028]).toBe(undefined);
  });
  it('manual income is independent of future award and valuation changes; holdings still appreciate',()=>{
    const p=G.prefillManual(plan(),2027),q=JSON.parse(JSON.stringify(p));
    q.stripeRetY3=.8;q.stripeGrants.years[2029]={arg:999999,peg:999999};
    expect(M.normComp(q,3)).toEqual(M.normComp(p,3));
    expect(M.run(q).R[4].sEnd).toBeGreaterThan(M.run(p).R[4].sEnd);
  });
  it('respects zero/manual cash and stock with no added QCA or PEG',()=>{
    const p=G.prefillManual(plan(),2027);p.stripeGrants.manualComp[2028]={cash:123000,stock:0};
    expect(M.normComp(p,2)).toEqual({cash:123000,stock:0});
    expect(M.run(p).R[2].sNew).toBe(0);
    expect(M.run(p).R[2].qcaCash).toBe(0);
  });
  it('preserves edits when cutoff is extended and shortened and seeds newly manual years',()=>{
    let p=G.prefillManual(plan(),2027);p.stripeGrants.manualComp[2028]={cash:1,stock:2};
    p=G.prefillManual(p,2030);expect(G.usesGrants(p,2028)).toBe(true);
    p=G.prefillManual(p,2026);expect(M.normComp(p,2)).toEqual({cash:1,stock:2});
    expect(p.stripeGrants.manualComp[2027].stock).toBeGreaterThan(0);
  });
  it('takes a fixed cutoff and manual calendar-year amounts through roll-forward',()=>{
    const p=G.prefillManual(plan(),2027),r=PM.rollForwardParams(p);
    expect(r.stripeGrants.throughYear).toBe(2027);
    expect(M.normComp(r,1)).toEqual(M.normComp(p,2));
  });
  it('saved cases retain their manual assumptions and inherit shared grant facts and cutoff',()=>{
    const p=G.prefillManual(plan(),2027),saved=G.stripFacts(p);
    saved.stripeGrants.manualComp[2028]={cash:50,stock:60};
    const loaded=G.withFacts(saved,p.stripeGrants);
    expect(loaded.stripeGrants.throughYear).toBe(2027);
    expect(M.normComp(loaded,2)).toEqual({cash:50,stock:60});
    const old=G.withFacts({stripeGrants:{defaultARG:90000}},p.stripeGrants);
    expect(old.stripeGrants.manualComp).toEqual(p.stripeGrants.manualComp);
  });
  it('manual all-years and all-grants choices are both available',()=>{
    const p=G.prefillManual(plan(),2025);
    expect(M.run(p).R.every(r=>r.sGrantDetails.manual)).toBe(true);
    const all=G.prefillManual(p,null);
    expect(M.run(all).R.some(r=>r.sGrantDetails.manual)).toBe(false);
  });
  it('rejects invalid manual amounts and ineffective legacy cash edits',()=>{
    const p=G.prefillManual(plan(),2027);
    expect(A.applyOverrides(p,{normCashY2:999999}).errors.length).toBe(1);
    expect(A.applyOverrides(p,{normCashY0:300000}).errors.length).toBe(0);
    p.stripeGrants.manualComp[2028].stock=-1;
    expect(G.validate(p).length).toBeGreaterThan(0);
  });
});
