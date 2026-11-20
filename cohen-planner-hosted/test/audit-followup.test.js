import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), M=require('../public/model'), F=require('../public/financial-independence');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const read=n=>fs.readFileSync(new URL('../public/'+n,import.meta.url),'utf8');
describe('audit follow-up regressions',()=>{
  it('resolves saved life events in the browser version of Budget',()=>{
    const ctx=vm.createContext({});ctx.window=ctx;
    for(const name of ['stripe-grants.js','model.js','budget.js'])vm.runInContext(read(name),ctx);
    const items=[{category:'oneoff',child:1,fromAge:13,toAge:13,amount:50000,label:'Family event'}];
    const out=ctx.PlannerBudget.overrides({...D,numKids:1,kid1Birth:2028,planItems:items});
    expect(out).toContainEqual(expect.objectContaining({type:'item',from:2041,to:2041,amount:50000}));
  });
  it('separates the share ceiling, income-only budget and reserves for a one-off event',()=>{
    const p={...D,homePurchaseYear:2031,planItems:[{from:2042,to:2042,category:'oneoff',amount:160000}],startingLiquid:3000000};
    const a=M.affordability(p,.25), b=M.affordability({...p,planItems:[]},.25);
    expect(a.shareLimit).toBe(b.shareLimit);
    expect(a.comfort).toBeLessThan(b.comfort);
    expect(a.gaps.some(r=>r.year===2042)).toBe(true);
    expect(a.peakShare.share).toBeGreaterThan(0);
  });
  it('keeps household savings, applies 2027 published thresholds, and honors charity overrides',()=>{
    const p={...D,homePurchaseYear:2031,pretax401k:30500,baseCharity:0,normStockY1:0};
    const rows=M.run(p).R;
    expect(rows[0].preTax).toBe(p.pretax401k+p.pretaxBenefits);
    const plain={...p,pretax401k:0,pretaxBenefits:0,_normW2:100000,_nancyW2:0};
    expect(M.calcTax(100000,plain,2027,0).deduction).toBe(33200);
    const charitable=M.run({...p,livingCharityY5:50000}).R;
    expect(charitable[5].tax).toBeLessThan(rows[5].tax);
    expect(charitable[5].livFullParts.charity).toBe(50000);
    expect(charitable[5].taxTotal).toBe(charitable[5].tax+charitable[5].taxInvestment+charitable[5].taxRetirement);
  });
  it('mirrors Base cash and reprices only the stock fraction in the active Optimistic case',()=>{
    const {attach}=require('../optimistic-comp');
    const source={...D,normCashY1:177000,normGrowth:.04,stripeManualLater:{2037:{cash:312345,stock:230000}}};
    const opts={...D,normStockY1:190000,startingStripeEquity:300000,stripeGrants:{priceYear:2026,referenceTender:63}};
    const inputs=[{name:'Base Case',params:source},{name:'Optimistic',params:opts},{name:'Conservative',params:D}];
    const fresh=attach(inputs);expect(fresh[0]).toBe(inputs[0]);expect(fresh[2]).toBe(inputs[2]);
    const q=fresh[1].params;
    for(let y=0;y<33;y++)expect(M.normComp(q,y).cash).toBe(M.normComp({...source,normManualThroughYear:2037},y).cash);
    expect(M.normComp(q,0).stock).toBe(opts.normStockY0);
    expect(M.normComp(q,1).stock).toBeGreaterThan(opts.normStockY1);
    const flat={...q,...Object.fromEntries(Array.from({length:10},(_,i)=>['stripeRetY'+i,0])),stripeLongTermReturn:0};
    expect(M.normComp(flat,3).stock).toBeCloseTo(M.nominalNormComp(q,3).stock);
    const up=M.optimisticVestingFactor({...q,optimisticVestShare:1},2029);
    expect(M.optimisticVestingFactor(q,2029)).toBeCloseTo((1+up)/2);
  });
  it('combined exit stress cuts Stripe holdings and blocks two years of sales',()=>{
    const p={...D,startingStripeEquity:450000,homePurchaseYear:2031,pretax401k:30500};
    const c={transitionYear:2034,stress:'combined'};
    const b=F.analyze(p,{},M,{scan:false,stresses:false}), t=F.analyze(p,c,M,{scan:false,stresses:false});
    expect(t.transition.gross).toBe(0);
    expect(t.transition.sEnd).toBeLessThan(b.opening.sEnd*.9);
    expect(t.result.R.filter(r=>r.stripeSalesBlocked).map(r=>r.yr)).toEqual([2034,2035]);
    expect(t.transition.sHold+t.transition.sSold).toBe(0);
  });
});
