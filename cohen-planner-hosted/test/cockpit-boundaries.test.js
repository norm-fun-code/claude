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
    const gap = opts.openingGap;
    const ctx = {
      inflationView: !!opts.inflationView,
      P: { planStartYear: 2026 },
      UI: { money: (v, o) => (o && o.exact ? '$' + Math.round(v).toLocaleString('en-US') : '$' + v) },
    };
    vm.createContext(ctx);
    vm.runInContext(src.slice(src.indexOf('function cockpitDelta'), src.indexOf('function cockpitSetExRet')), ctx);
    return ctx.cockpitDelta(projected, today, row, gap, opts.gapParts);
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

  // What the reader is asking is "where am I today versus year end", so today is the
  // OBSERVED balance. When the plan's opening sits below that, the year's movement really is
  // smaller — the projection is compounding a smaller number — and that is a fact to surface,
  // not arithmetic to hide.
  it('measures from today, not from the plan\'s opening', () => {
    // Year-end $1,351,930 against $1,346,045 observed is +$5,885, even though the plan's own
    // opening is $51,259 lower and its internal movement is +$57,144.
    expect(delta(1351930, 1346045, {}, { openingGap: 51259 })).toContain('+$5,885 from today');
  });

  it('names what the gap is made of rather than issuing an instruction', () => {
    // Some of what sits outside the plan's opening is deliberately outside it — accounts
    // hidden on purpose, a private position kept separate. Telling someone to go and fix a
    // choice they made is worse than saying nothing, so this states a fact and its parts.
    const out = delta(1351930, 1346045, {}, { openingGap: 51259,
      gapParts: ['Vested Stripe equity is set by hand at $623,741, $51,259 under the accounts'] });
    expect(out).toContain('the plan compounds $1,294,786');
    expect(out).toContain('$51,259 less than you hold');
    expect(out).toContain('Vested Stripe equity is set by hand at $623,741');
    expect(out).not.toMatch(/classify the rest|you should|go and/i);
    // Rounding noise is not a gap worth a sentence.
    expect(delta(1412096, 1350000, {}, { openingGap: 40 })).not.toContain('the plan compounds');
  });

  it('reads the other direction without inventing a remedy', () => {
    const out = delta(1351930, 1346045, {}, { openingGap: -20000 });
    expect(out).toContain('$20,000 more than you hold');
  });

  it('says only the amount when the composition cannot be attributed', () => {
    const out = delta(1351930, 1346045, {}, { openingGap: 51259 });
    expect(out).toContain('$51,259 less than you hold');
    expect(out).not.toContain(' — ');   // no dangling breakdown separator
  });

  it('is wired into the year-end headline', () => {
    expect(src).toContain('cockpitDelta(deflate(cpNw(selected),selected.yr),todayNw,selected,openingGap,gapParts)');
    expect(src).toContain('const todayNw=obsNw!=null?obsNw:openingNw;');
    // Hidden accounts leave the hero and the opening alike, so hiding can never be the gap.
    expect(src).toContain('hidden accounts leave the hero and the opening alike');
    // The reason comes from the module that decides it, not from guessing at classes.
    expect(src).toContain('PlannerOpening.observedOpening(P,s,available)');
    // …and today is measured on whichever basis the toggle is showing.
    expect(src).toContain('cockpitExRet?0:(Number(P.k401Start)||0)');
  });
});

// ── Hiding an account is not a gap ───────────────────────────────────────
// Accounts hidden on purpose are excluded from the observed hero and from the plan's opening
// alike, so hiding can never make the two disagree. Worth a test, because the delta line once
// told someone to go and reclassify accounts they had deliberately put out of sight.
describe('hidden accounts', () => {
  const accts = [
    { id: '1', name: 'Chase Checking', balance: 60000, category: 'cash' },
    { id: '2', name: 'Fidelity Brokerage', balance: 559786, category: 'investment' },
    { id: '3', name: 'Stripe Equity', balance: 675000, category: 'investment' },
    { id: '4', name: 'Old 2014 Savings', balance: 40000, category: 'cash' },
    { id: '5', name: 'Fidelity 401k', balance: 297000, category: 'retirement' },
  ];
  const sides = (overrides) => {
    const s = Accounts.summarize(accts, overrides);
    return { hero: s.netWorth - (s.byClass.retirement?.total || 0),
             opening: s.accessible + s.stripeVested, hiddenNet: s.hiddenNet };
  };

  it('leaves the hero and the plan opening equal, hidden or not', () => {
    const open = sides({}), hidden = sides({ '4': { hidden: true } });
    expect(open.hero).toBe(open.opening);
    expect(hidden.hero).toBe(hidden.opening);        // ← hiding cannot open a gap
    expect(hidden.hiddenNet).toBe(40000);
    expect(open.hero - hidden.hero).toBe(40000);     // both sides fall together
  });
});
