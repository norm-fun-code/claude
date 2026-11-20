import { describe,it,expect } from 'vitest';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), U=require('../conservative-case-update');
const {conservativeSchedule}=require('../promotion-comp-scenarios'), M=require('../public/model'), L=require('../public/liquidity');

describe('Conservative plan calibration',()=>{
  it('preserves opening facts and 2026 pay, gives the March 2027 raise and retains L3 prior-year awards',()=>{
    const p={planStartYear:2026,normCashY0:257000,normStockY0:155000,startingStripeEquity:600000,startingLiquid:800000,
      stripeGrants:{enabled:false,priceYear:2026,referenceTender:63},homePrice:2000000,combinedIncomeCap:750000,investReturn:.05};
    const q=U.patch(p);
    expect(M.normComp(q,0)).toEqual({cash:257000,stock:155000});
    expect(M.normComp(q,1)).toEqual({cash:Math.round(210000/6+226800*5/6+210000*.15*1.5),stock:100000+75000});
    expect(M.normComp(q,3).cash).toBe(Math.round(226800*1.03/6+226800*1.03**2*5/6+226800*1.03*.20));
    expect(conservativeSchedule().at(-1).stock).toBe(165000);
    expect(q).toMatchObject({startingStripeEquity:600000,startingLiquid:800000,stripeGrants:p.stripeGrants,homePrice:2000000,combinedIncomeCap:750000,investReturn:.05});
    for(let i=0;i<12;i++)expect(M.stripeReturn(q,i)).toBe(0);
    expect(q.nancyHourlyRate*q.nancyRampClients*q.nancyWeeksPerYear).toBe(44000);
    expect(q.nancyHourlyRate*q.nancyMaxClients*q.nancyWeeksPerYear).toBe(132000);
    expect(q.nancyRampYear+q.nancyRampYears).toBe(2034);
  });

  it.each([false,true])('updates only the active Conservative case and skips a dirty working copy (dirty: %s)',async dirty=>{
    const original={planStartYear:2026,normCashY0:257000,homePrice:2000000};
    const rows=['Base Case','Conservative','Optimistic','Conservative Plan'].map((name,i)=>({id:String(i),name,params:{...original,...(i===3?{_archived:true}:{})}}));
    const saved={activeScenarioId:'1',scenarioDirty:dirty,P:original};
    const changes=[]; let journal=false, releases=0;
    const pool={connect:async()=>({release:()=>releases++,query:async(sql,args)=>{
      if(sql.startsWith('SELECT id FROM planner_data_updates'))return{rowCount:+journal};
      if(sql.startsWith('SELECT state'))return{rows:[{state:saved}]};
      if(sql.startsWith('SELECT id,name,params'))return{rows};
      if(sql.startsWith('UPDATE '))changes.push([sql,args]);
      if(sql.startsWith('INSERT INTO planner_data_updates'))journal=true;
      return {rows:[]};
    }})};
    expect(await U.apply(pool)).toEqual({updated:true,activeCaseRefreshed:!dirty});
    expect(changes.filter(x=>x[0].startsWith('UPDATE scenarios')).map(x=>x[1][1])).toEqual(['1']);
    expect(changes.filter(x=>x[0].startsWith('UPDATE planner_state'))).toHaveLength(dirty?0:1);
    expect(await U.apply(pool)).toEqual({alreadyApplied:true});expect(changes).toHaveLength(dirty?1:2);expect(releases).toBe(2);
  });

  it('tests a delayed tender separately from the plan',()=>{
    const p={stripeSimplified:true,stripeTenderQuarters:[1,4]};
    const ctx={year:2031,quarter:2,need:500000,heldValue:700000,vestPerQuarter:25000,otherCash:200000};
    expect(L.fundingCheck(ctx,p).fundable).toBe(true);
    expect(L.stressClosing(ctx,p)).toMatchObject({fromStripe:0,shortfall:300000,nextWindow:{quarter:3,kind:'tender'}});
    expect(L.stressClosing({...ctx,quarter:3},p).grossFromStripe).toBeCloseTo((700000+3*25000)*.7);
    expect(p.stripeTenderQuarters).toEqual([1,4]);
  });
});
