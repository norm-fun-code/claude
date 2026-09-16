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
    const r=Accounts.reconcile(n.summary,P);
    // Every ASSET line stays blocked while a liability is unaccounted for — applying gross
    // balances over debt is the overstatement this guard exists to prevent.
    expect(r.lines.filter(l=>l.key!=='otherDebt').every(l=>!l.applicable)).toBe(true);
    // The one line that is allowed through is the liability itself. It is the remedy, not a
    // gross balance, and blocking it would leave no way out of the block.
    const debt=r.lines.find(l=>l.key==='otherDebt');
    expect(debt.applicable).toBe(true);
    expect(debt.actual).toBe(25);
    // …and once it is applied, the DEBT block lifts. Lines still blocked after that are
    // blocked for their own reasons — here, a $210k retirement assumption that no classified
    // account backs, which is a separate guard and must survive this one being satisfied.
    const after=Accounts.reconcile(n.summary,{...P,otherDebt:25});
    expect(after.lines.some(l=>/revolving balance first/i.test(l.blockedReason||''))).toBe(false);
    expect(after.lines.find(l=>l.key==='startingLiquid').applicable).toBe(true);
    expect(after.lines.find(l=>l.key==='k401Start').blockedReason).toMatch(/classification/);
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

// ── The projection, stated as a change ───────────────────────────────────
// A year-end figure alone cannot be checked against anything. When today's net worth and the
// projected year-end both round to $1.35M, two cards read as one number printed twice — and
// there is nothing on screen to say whether that is a coincidence of rounding or a bug.
describe('the path-ahead delta', () => {
  const src = fs.readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
  // Run cockpitDelta against a context standing in for the page's globals.
  const delta = (projected, today, row = {}, opts = {}) => {
    const ctx = {
      inflationView: !!opts.inflationView,
      P: { planStartYear: 2026 },
      UI: { money: (v, o) => (o && o.exact ? '$' + Math.round(v).toLocaleString('en-US') : '$' + v) },
    };
    vm.createContext(ctx);
    vm.runInContext(src.slice(src.indexOf('function cockpitDelta'), src.indexOf('function cockpitSetExRet')), ctx);
    return ctx.cockpitDelta(projected, today, row);
  };

  it('states the movement in exact dollars, because rounded millions hide it', () => {
    // $1,412,096 and $1,350,000 both print as $1.35M / $1.41M; the difference is the point.
    const out = delta(1412096, 1350000);
    expect(out).toContain('+$62,096 from today');
    expect(out).toContain('data-dir="up"');
  });

  it('says so plainly when the projection really does not move', () => {
    const out = delta(1350000, 1350000);
    expect(out).toContain('No change from today');
    expect(out).toContain('data-dir="flat"');
    expect(out).not.toContain('+$0');   // "+$0 from today" reads as a rendering failure
  });

  it('shows a fall as a fall rather than an unsigned number', () => {
    const out = delta(1278443, 1350000);
    expect(out).toContain('−$71,557 from today');
    expect(out).toContain('data-dir="down"');
  });

  it('flags the house, which the projection carries and observed accounts do not', () => {
    expect(delta(2704153, 1350000, { eq: 900000 })).toContain('includes home equity');
    expect(delta(1412096, 1350000, { eq: 0 })).not.toContain('home equity');
  });

  it('names the basis when the figure has been deflated', () => {
    expect(delta(2e6, 1350000, {}, { inflationView: true })).toContain('in 2026 purchasing power');
    expect(delta(2e6, 1350000)).not.toContain('purchasing power');
  });

  it('renders nothing rather than NaN when either side is unknown', () => {
    for (const [a, b] of [[NaN, 1], [1, NaN], [null, 1], [1, undefined]]) expect(delta(a, b)).toBe('');
  });

  it('is wired into the year-end headline', () => {
    expect(src).toContain('cockpitDelta(deflate(cpNw(selected),selected.yr),todayNw,selected)');
    // …and today is measured on whichever basis the toggle is showing.
    expect(src).toContain('cockpitExRet?0:(Number(P.k401Start)||0)');
  });
});
