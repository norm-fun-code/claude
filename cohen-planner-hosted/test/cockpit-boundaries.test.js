import {describe,it,expect} from 'vitest';
import {createRequire} from 'module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const normalize=require('../account-snapshot');
const Spending=require('../public/spending');
const Accounts=require('../public/accounts');
const Model=require('../public/model');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const P=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
describe('cockpit financial boundaries',()=>{
  it('preserves missing accounts in every summary',()=>{
    const n=normalize({asOf:'2026-09-11',partial:true,accounts:[{id:'cash',name:'Checking',balance:100}],missingAccounts:[{id:'missing',name:'Brokerage'}]}, {},Date.parse('2026-09-11'));
    expect(n.summary.complete).toBe(false);expect(n.accounts).toHaveLength(2);expect(n.summary.unknownBalance).toHaveLength(1);
  });
  it('does not treat empty or undated snapshots as fresh complete wealth',()=>{
    expect(normalize({accounts:[]}).summary.complete).toBe(false);
    expect(normalize({accounts:[{id:'a',name:'Checking',balance:100}]}).stale).toBe(true);
  });
  it('never applies gross balances over liabilities',()=>{
    const n=normalize({asOf:'2026-09-11',accounts:[{id:'a',name:'Checking',balance:100},{id:'b',name:'Credit Card',balance:-25}]});
    const r=Accounts.reconcile(n.summary,P);expect(r.lines.every(l=>!l.applicable)).toBe(true);
  });
  it('rejects unverified and noncontiguous spending history',()=>{
    const months=['2026-01','2026-03','2026-06'].map(month=>({month,expense:100}));
    expect(Spending.coverage(months,'2026-07-01').completeMonths).toEqual([]);
    expect(Spending.rollingAverage(months.map(m=>({...m,coverageVerified:true})),3,null,'2026-07-01')).toBe(null);
  });
  it('a partially imported calendar month is not a complete month',()=>{
    const months=[{month:'2026-06',expense:100}];
    expect(Spending.coverage(months,'2026-07-01',{'2026-06':{startDate:'2026-06-12',endDate:'2026-06-30'}}).completeMonths).toEqual([]);
  });
  it('closing costs and insurance actually alter the shared projection',()=>{
    const a=Model.run(P).R,b=Model.run({...P,homeInsuranceAnnual:25000,closingLegalFees:250000}).R;
    expect(b.find(r=>r.yr===P.homePurchaseYear).totE).toBeGreaterThan(a.find(r=>r.yr===P.homePurchaseYear).totE);
  });
  it('a plan with no sale windows cannot sell Stripe',()=>{
    const r=Model.run({...P,stripePolicy:'sell',stripeTenderQuarters:[],stripeElectiveCashPerQuarter:0,stripeElectiveCashAnnualCap:0,stripeLiquidityFromYear:null}).R;
    expect(r.every(y=>y.sSold===0&&y.sHold===0)).toBe(true);
  });
});
