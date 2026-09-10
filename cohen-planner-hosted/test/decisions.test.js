import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const { run }=require('../public/model.js');
const { variant,summarize,preset,usableSnapshot,milestones }=require('../public/decisions.js');
const { extractAccounts }=require('../monarch-accounts.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const defaults=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');

describe('Decision Room calculations',()=>{
  it('leaves the baseline intact when combining decisions and reproduces the shared engine',()=>{
    const original=JSON.stringify(defaults);
    const params=variant(defaults,{...preset(defaults,'smaller'),...preset(defaults,'care')});
    const R=run(params).R;
    const summary=summarize(params,R,params.planStartYear);
    expect(JSON.stringify(defaults)).toBe(original);
    // Net worth now carries Stripe equity as its own component alongside the diversified
    // pool and home equity, so the grand total picks it up too.
    expect(Math.abs(summary.total-(R.at(-1).liq+R.at(-1).sEnd+R.at(-1).eq+R.at(-1).k401))).toBeLessThanOrEqual(1);
    expect(summary.floor.liq).toBe(Math.min(...R.map(r=>r.liq)));
    expect(summary.current.surp).toBe(R[0].inc-R[0].totE);
  });
  it('uses starting liquidity for a first-year home and does not treat year-end balance as closing cash',()=>{
    const p={...defaults,homePurchaseYear:defaults.planStartYear};
    const s=summarize(p,run(p).R,p.planStartYear);
    expect(s.closingBuffer).toBe(p.startingLiquid-p.homePrice*p.downPctg/100);
    expect(s.closingBuffer).not.toBe(s.purchase.liq);
  });
  it('counts Stripe equity toward the down payment, since the waterfall sells it to close',()=>{
    // Same total wealth, split differently. Readiness must not change just because the money
    // is labelled Stripe — the funding waterfall reaches it once the portfolio hits its floor.
    const liquidOnly={...defaults,homePurchaseYear:defaults.planStartYear,
      startingLiquid:1100000,startingStripeEquity:0};
    const split={...liquidOnly,startingLiquid:600000,startingStripeEquity:500000};
    const a=summarize(liquidOnly,run(liquidOnly).R,liquidOnly.planStartYear);
    const b=summarize(split,run(split).R,split.planStartYear);
    expect(b.beforeAssets).toBe(a.beforeAssets);
    expect(b.closingBuffer).toBe(a.closingBuffer);
    expect(b.closingBuffer).toBe(1100000-liquidOnly.homePrice*liquidOnly.downPctg/100);
  });
  it('carries Stripe into the buffer in later purchase years too',()=>{
    const p={...defaults,homePurchaseYear:defaults.planStartYear+4,startingStripeEquity:400000};
    const R=run(p).R;
    const before=R.find(r=>r.yr===p.homePurchaseYear-1);
    const s=summarize(p,R,p.planStartYear);
    expect(before.sEnd).toBeGreaterThan(0);
    expect(s.beforeAssets).toBe(before.liq+before.sEnd);
    expect(s.beforeAssets).toBeGreaterThan(before.liq); // not the portfolio alone
  });
  it('does not invent a closing buffer for a purchase outside the projection',()=>{
    const p={...defaults,homePurchaseYear:2090};
    expect(summarize(p,run(p).R,2026).closingBuffer).toBeNull();
  });
  it('handles a one-year horizon with no future milestones',()=>{
    const p={...defaults,planEndYear:2026};const R=run(p).R;
    expect(summarize(p,R,2099).current.yr).toBe(2026);
    expect(milestones(p,R)).toEqual([]);
  });
  it('caps the initial practice ramp when previewing fewer clients',()=>{
    const p=variant(defaults,{nancyMaxClients:2});
    expect(p.nancyRampClients).toBe(2);
    expect(p.nancyMaxClients).toBe(2);
  });
  it('rejects invalid and unexpected input rather than producing NaN projections',()=>{
    expect(()=>variant(defaults,{homePrice:NaN})).toThrow();
    expect(()=>variant(defaults,{startingLiquid:0})).toThrow();
    expect(()=>variant(defaults,{investReturn:-1})).toThrow();
  });
});
describe('Monarch snapshot trust',()=>{
  const account={name:'Example',currentBalance:'$1,234.50'};
  it.each([
    {result:{structuredContent:{accounts:[account]}}},
    {result:{structuredContent:{result:{accounts:[account]}}}},
    {result:{content:[{type:'text',text:JSON.stringify({result:JSON.stringify({data:{accounts:[account]}})})}]}},
  ])('accepts documented MCP envelope variants',response=>expect(extractAccounts(response)).toEqual([account]));
  it.each([
    {result:{isError:true,content:[{type:'text',text:'Unavailable'}]}},
    {result:{structuredContent:{accounts:[]}}},
    {result:{structuredContent:{accounts:[{balance:null}]}}},
    {result:{structuredContent:{accounts:[{balance:'N/A'}]}}},
    {result:{structuredContent:{accounts:[{balance:Infinity}]}}},
    {result:{content:[{type:'text',text:'Service temporarily unavailable'}]}},
  ])('rejects an incomplete response instead of returning zero',response=>expect(()=>extractAccounts(response)).toThrow());
  it('accepts explicit zero balances, while rejecting unverified legacy zero snapshots',()=>{
    expect(extractAccounts({result:{structuredContent:{accounts:[{balance:0}]}}})).toHaveLength(1);
    const zero={netWorth:0,liquid:0,retirement:0,assets:0,liabilities:0,syncedAt:'2026-09-08'};
    expect(usableSnapshot(zero)).toBe(false);
    expect(usableSnapshot({...zero,accountCount:1})).toBe(true);
    expect(usableSnapshot({...zero,assets:100,netWorth:100,liquid:100})).toBe(true);
  });
});

it('does not use an incomplete account subtotal as verified net worth',()=>{
  expect(usableSnapshot({netWorth:100,liquid:100,retirement:0,assets:100,liabilities:0,accountCount:1,syncedAt:'2026-09-10T00:00:00Z',partial:true})).toBe(false);
});
