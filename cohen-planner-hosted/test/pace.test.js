import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'module';
const require=createRequire(import.meta.url);
const Pace=require('../public/pace.js');
const Spending=require('../public/spending.js');

// Build a ledger: [{month, day, amount, category}] → Monarch-shaped rows.
const tx=(rows)=>rows.map((r,i)=>({id:'t'+i,date:`${r.m}-${String(r.d).padStart(2,'0')}`,
  amount:-r.amt,categoryName:r.cat||'Dining'}));
const cats=new Map();

describe('Pace compares like with like, by day of month',()=>{
  it('does not call the 2nd of the month a blowout because rent landed on the 1st',()=>{
    // The failure mode a linear pro-rate produces: every month front-loads a big fixed
    // charge, so by day 2 you are "300% over" in all of them.
    const rows=[];
    for(const m of ['2026-05','2026-06','2026-07','2026-08']){
      rows.push({m,d:1,amt:3000,cat:'Shopping'});   // a big, habitual day-1 charge
      for(let d=2;d<=28;d++)rows.push({m,d,amt:40,cat:'Dining'});
    }
    const p=Pace.pace(tx(rows),cats,{asOf:'2026-08-02'});
    expect(p.status).toBe('ok');
    // By day 2 every month had spent ~$3,040. This month is normal, and says so.
    expect(p.verdict).toBe('about');
    expect(Math.round(p.typical)).toBe(3040);
    expect(Math.round(p.mtd)).toBe(3040);
  });

  it('measures the current month against the same day, not the whole month',()=>{
    const rows=[];
    for(const m of ['2026-05','2026-06','2026-07'])
      for(let d=1;d<=28;d++)rows.push({m,d,amt:100});
    rows.push(...[1,2,3,4,5].map(d=>({m:'2026-08',d,amt:100})));
    const p=Pace.pace(tx(rows),cats,{asOf:'2026-08-05'});
    // $500 so far against $500 typical by the 5th — not $500 against a $2,800 month.
    expect(p.mtd).toBe(500);
    expect(p.typical).toBe(500);
    expect(p.verdict).toBe('about');
  });
});

describe('"Above typical" means outside the household\'s own range',()=>{
  const steady=()=>{
    const rows=[];
    for(const m of ['2026-04','2026-05','2026-06','2026-07'])
      for(let d=1;d<=20;d++)rows.push({m,d,amt:100});
    return rows;
  };

  it('flags a month that is genuinely unusual for this household',()=>{
    const rows=[...steady(),...Array.from({length:10},(_,i)=>({m:'2026-08',d:i+1,amt:260}))];
    const p=Pace.pace(tx(rows),cats,{asOf:'2026-08-10'});
    expect(p.mtd).toBe(2600);
    expect(p.typical).toBe(1000);
    expect(['above','well above']).toContain(p.verdict);
    expect(p.tone).toMatch(/warn|bad/);
  });

  it('does not flag a swing a volatile household has every month',()=>{
    // Same $1,500 overage, but this household routinely swings that much.
    const rows=[];
    const months=[{m:'2026-04',amt:60},{m:'2026-05',amt:190},
      {m:'2026-06',amt:70},{m:'2026-07',amt:180}];
    for(const x of months)for(let d=1;d<=10;d++)rows.push({m:x.m,d,amt:x.amt});
    for(let d=1;d<=10;d++)rows.push({m:'2026-08',d,amt:150});
    const p=Pace.pace(tx(rows),cats,{asOf:'2026-08-10'});
    expect(p.mtd).toBe(1500);
    // Within its own noise, so it is not news.
    expect(p.verdict).toBe('about');
  });

  it('reports the normal range in dollars, which is the actionable form',()=>{
    const rows=[...steady(),...Array.from({length:10},(_,i)=>({m:'2026-08',d:i+1,amt:100}))];
    const p=Pace.pace(tx(rows),cats,{asOf:'2026-08-10'});
    expect(p.normalLow).toBeLessThan(p.typical);
    expect(p.normalHigh).toBeGreaterThan(p.typical);
    expect(p.normalLow).toBeGreaterThanOrEqual(0);   // never a negative dollar floor
  });

  it('does not divide by a zero spread when every month was identical',()=>{
    const rows=[];
    for(const m of ['2026-04','2026-05','2026-06','2026-07','2026-08'])
      for(let d=1;d<=10;d++)rows.push({m,d,amt:100});
    const p=Pace.pace(tx(rows),cats,{asOf:'2026-08-10'});
    expect(Number.isFinite(p.z)).toBe(true);
    expect(p.verdict).toBe('about');
  });
});

describe('Committed costs are excluded, and the rule is declared',()=>{
  it('leaves rent, tuition and insurance out of discretionary',()=>{
    for(const name of ['Rent','Mortgage','Tuition','Child Care','Auto Insurance',
      'Utilities','Student Loan','Property Tax'])
      expect(Pace.isCommitted(name),name).toBe(true);
    for(const name of ['Dining','Shopping','Travel','Entertainment','Groceries'])
      expect(Pace.isCommitted(name),name).toBe(false);
  });

  it('ignores a rent rise entirely, because it is not this month\'s decision',()=>{
    const rows=[];
    for(const m of ['2026-05','2026-06','2026-07'])
      {rows.push({m,d:1,amt:5000,cat:'Rent'});for(let d=1;d<=10;d++)rows.push({m,d,amt:100,cat:'Dining'});}
    rows.push({m:'2026-08',d:1,amt:9000,cat:'Rent'});   // rent nearly doubled
    for(let d=1;d<=10;d++)rows.push({m:'2026-08',d,amt:100,cat:'Dining'});
    const p=Pace.pace(tx(rows),cats,{asOf:'2026-08-10'});
    expect(p.mtd).toBe(1000);          // rent never enters the number
    expect(p.verdict).toBe('about');
  });

  it('lets the household override the rule with its own list',()=>{
    const rows=[];
    for(const m of ['2026-05','2026-06','2026-07','2026-08'])
      for(let d=1;d<=10;d++)rows.push({m,d,amt:100,cat:'Gym'});
    const dflt=Pace.pace(tx(rows),cats,{asOf:'2026-08-10'});
    expect(dflt.mtd).toBe(1000);                       // Gym is discretionary by default
    const owned=Pace.pace(tx(rows),cats,{asOf:'2026-08-10',committedCategories:['Gym']});
    expect(owned.status).toBe('insufficient');          // nothing discretionary left at all
    expect(dflt.committedRule).toBe('default pattern');
    expect(owned.committedRule).toBe('your list');
  });
});

describe('Drivers are flagged only when they are both unusual and material',()=>{
  const base=()=>{
    const rows=[];
    for(const m of ['2026-05','2026-06','2026-07']){
      for(let d=1;d<=10;d++){rows.push({m,d,amt:60,cat:'Dining'});rows.push({m,d,amt:40,cat:'Shopping'});}
      rows.push({m,d:3,amt:20,cat:'Coffee'});
    }
    return rows;
  };

  it('names the category actually driving the gap',()=>{
    const rows=[...base()];
    for(let d=1;d<=10;d++){rows.push({m:'2026-08',d,amt:60,cat:'Dining'});
      rows.push({m:'2026-08',d,amt:240,cat:'Shopping'});}
    rows.push({m:'2026-08',d:3,amt:20,cat:'Coffee'});
    const p=Pace.pace(tx(rows),cats,{asOf:'2026-08-10'});
    const names=p.flagged.map(d=>d.category);
    expect(names).toContain('Shopping');
    expect(names).not.toContain('Dining');
    const shopping=p.drivers.find(d=>d.category==='Shopping');
    expect(shopping.over).toBeCloseTo(2000,0);
    expect(shopping.shareOfGap).toBeGreaterThan(0.9);
  });

  it('does not flag a category that doubled from trivial to trivial',()=>{
    const rows=[...base()];
    for(let d=1;d<=10;d++){rows.push({m:'2026-08',d,amt:60,cat:'Dining'});
      rows.push({m:'2026-08',d,amt:40,cat:'Shopping'});}
    rows.push({m:'2026-08',d:3,amt:44,cat:'Coffee'});   // 20 → 44, unusual but immaterial
    const p=Pace.pace(tx(rows),cats,{asOf:'2026-08-10'});
    expect(p.flagged.map(d=>d.category)).not.toContain('Coffee');
  });

  it('flags nothing at all in a normal month',()=>{
    const rows=[...base()];
    for(let d=1;d<=10;d++){rows.push({m:'2026-08',d,amt:60,cat:'Dining'});
      rows.push({m:'2026-08',d,amt:40,cat:'Shopping'});}
    rows.push({m:'2026-08',d:3,amt:20,cat:'Coffee'});
    expect(Pace.pace(tx(rows),cats,{asOf:'2026-08-10'}).flagged).toEqual([]);
  });
});

describe('It refuses to judge a month it cannot measure',()=>{
  it('will not build a range from fewer than three complete months',()=>{
    const rows=[];
    for(const m of ['2026-07','2026-08'])for(let d=1;d<=10;d++)rows.push({m,d,amt:100});
    const p=Pace.pace(tx(rows),cats,{asOf:'2026-08-10'});
    expect(p.status).toBe('insufficient');
    expect(p.verdict).toBe(undefined);        // no verdict is produced at all
    expect(p.needs[0].have).toBe(1);
    expect(p.needs[0].need).toBe(3);
    expect(p.note).toMatch(/Nothing here is a verdict/);
  });

  it('says so when the current month has no transactions yet',()=>{
    const rows=[];
    for(const m of ['2026-05','2026-06','2026-07'])for(let d=1;d<=10;d++)rows.push({m,d,amt:100});
    const p=Pace.pace(tx(rows),cats,{asOf:'2026-08-01'});
    expect(p.status).toBe('insufficient');
    expect(p.needs.some(n=>n.field==='currentMonth')).toBe(true);
  });
});

describe('It counts the same spending the rest of the app counts',()=>{
  it('excludes transfers, card payments and investments when a classifier is supplied',()=>{
    const rows=[];
    for(const m of ['2026-05','2026-06','2026-07','2026-08'])
      for(let d=1;d<=10;d++)rows.push({m,d,amt:100,cat:'Dining'});
    const txns=tx(rows);
    // A large card payment in the current month must not read as spending — the
    // purchases it settles were already counted when they happened.
    txns.push({id:'cp',date:'2026-08-05',amount:-9000,categoryName:'Credit Card Payment'});
    const classify=t=>Spending.classify(t,cats,{});
    const p=Pace.pace(txns,cats,{asOf:'2026-08-10',classify});
    expect(p.mtd).toBe(1000);
    expect(p.verdict).toBe('about');
  });

  it('nets a refund against the month it lands in',()=>{
    const rows=[];
    for(const m of ['2026-05','2026-06','2026-07','2026-08'])
      for(let d=1;d<=10;d++)rows.push({m,d,amt:100,cat:'Shopping'});
    const txns=tx(rows);
    txns.push({id:'r',date:'2026-08-06',amount:400,categoryName:'Shopping'}); // a return
    const p=Pace.pace(txns,cats,{asOf:'2026-08-10'});
    expect(p.mtd).toBe(600);
    expect(p.tone).toBe('good');
  });
});

// ── The monitor ─────────────────────────────────────────────────────────────
// Pace as a proactive signal, not just a card you have to go and look at.
describe('Discretionary pace as a watchlist signal',()=>{
  const Monitors=require('../public/monitors.js');
  const hot={status:'ok',month:'2026-08',day:11,mtd:4803,typical:1753,
    normalLow:1490,normalHigh:2016,over:3050,verdict:'well above',tone:'bad',
    monthsCompared:3,
    flagged:[{category:'Travel',mtd:1750,typical:0,over:1750},
             {category:'Shopping',mtd:1620,typical:320,over:1300}]};

  it('raises one alert, keyed on the month rather than the moment',()=>{
    const a=Monitors.spendingPace({pace:hot}).alerts[0];
    expect(a).toBeTruthy();
    expect(a.key).toBe('spendingPace:2026-08');
    // Re-detecting tomorrow must not produce a second alert to dismiss.
    expect(Monitors.spendingPace({pace:{...hot,day:12}}).alerts[0].key).toBe(a.key);
  });

  it('names the drivers in the evidence and in the action',()=>{
    const a=Monitors.spendingPace({pace:hot}).alerts[0];
    const labels=a.evidence.map(e=>e.label);
    expect(labels).toContain('Travel');
    expect(labels).toContain('Shopping');
    expect(a.action).toMatch(/travel/i);
    expect(a.action).toMatch(/20 days left/);      // August has 31 days
  });

  it('quotes the normal range rather than a percentage',()=>{
    const a=Monitors.spendingPace({pace:hot}).alerts[0];
    const range=a.evidence.find(e=>/Normal for you/.test(e.label));
    expect(range.value).toMatch(/\$1,490–\$2,016/);
    expect(range.source).toMatch(/same day of 3 earlier months/);
  });

  it('stays quiet at the merely-above band, which is a normal fluctuation',()=>{
    // Alerting every other month is how a watchlist teaches someone to ignore it.
    for(const tone of ['good','neutral','warn'])
      expect(Monitors.spendingPace({pace:{...hot,tone}}).alerts,tone).toEqual([]);
  });

  it('reports itself unchecked rather than clear when history is short',()=>{
    const out=Monitors.spendingPace({pace:{status:'insufficient',
      needs:[{field:'completeMonths',why:'Only 1 complete month.'}]}});
    expect(out.alerts).toEqual([]);
    expect(out.skipped[0].missing).toBe('completeMonths');
  });

  it('reports itself unchecked when there is no ledger at all',()=>{
    const out=Monitors.spendingPace({});
    expect(out.alerts).toEqual([]);
    expect(out.skipped[0].missing).toMatch(/dated transaction ledger/);
  });

  it('is wired into the checks that actually run',()=>{
    const out=Monitors.detect({today:'2026-08-11'});
    expect(out.checksTotal).toBe(7);
    expect(out.skipped.some(s=>s.kind==='spendingPace')).toBe(true);
  });
});

// "Clothing is up $330" tells you where to look. Whether it was ONE purchase or a pattern
// tells you whether to care — a sofa is not a habit, and the two call for opposite
// responses. The ledger can tell them apart, so the app should not leave it as homework.
const P=Pace, Monitors=require('../public/monitors.js');
describe('what is actually driving a category', () => {
  const t = (date, amount, categoryName, merchant) => ({ date, amount: -amount, categoryName, merchant });
  const quietPriors = () => {
    const out = [];
    for (const m of ['06', '07', '08']) {
      for (let d = 2; d <= 28; d += 3) out.push(t(`2026-${m}-${String(d).padStart(2, '0')}`, 120, 'Groceries', 'Whole Foods'));
      out.push(t(`2026-${m}-06`, 150, 'Dining', 'Via Carota'));
      out.push(t(`2026-${m}-12`, 150, 'Dining', 'Lilia'));
      out.push(t(`2026-${m}-14`, 60, 'Clothing', 'Uniqlo'));
    }
    return out;
  };
  const thisMonthBase = () => {
    const out = [];
    for (let d = 2; d <= 14; d += 3) out.push(t(`2026-09-${String(d).padStart(2, '0')}`, 120, 'Groceries', 'Whole Foods'));
    return out;
  };
  const run = extra => P.pace([...quietPriors(), ...thisMonthBase(), ...extra], null, { asOf: '2026-09-14' });

  it('names a single purchase from a merchant with no history as a one-off', () => {
    const r = run([t('2026-09-08', 474, 'Clothing', 'H&M')]);
    const x = r.headlineDriver.explain;
    expect(x.kind).toBe('one-off');
    expect(x.merchant).toBe('H&M');
    expect(x.newToYou).toBe(true);
    expect(x.sentence).toMatch(/one-time H&M purchase of \$474 is most of it/);
  });

  it('calls a familiar merchant more of the same, not a surprise', () => {
    // Same dollars, opposite meaning: this is a regular you leaned on harder.
    const r = run([t('2026-09-03', 400, 'Dining', 'Via Carota'), t('2026-09-09', 350, 'Dining', 'Via Carota')]);
    const x = r.headlineDriver.explain;
    expect(x.kind).toBe('more of the same');
    expect(x.newToYou).toBe(false);
    expect(x.sentence).toMatch(/which you spend on most months/);
  });

  it('refuses to name a culprit when nothing dominates', () => {
    // The important one. Picking the largest of five similar charges would read as an
    // explanation while being an arbitrary choice.
    const r = run([t('2026-09-02', 200, 'Dining', 'Lilia'), t('2026-09-04', 190, 'Dining', 'Rezdora'),
      t('2026-09-06', 180, 'Dining', 'Via Carota'), t('2026-09-09', 210, 'Dining', 'Misi'),
      t('2026-09-12', 200, 'Dining', 'Torrisi')]);
    const x = r.headlineDriver.explain;
    expect(x.kind).toBe('spread');
    expect(x.sentence).toMatch(/no single purchase explains it/);
    expect(x.merchantsInvolved).toBeGreaterThan(3);
  });

  it('claims nothing at all in a normal month', () => {
    const r = run([t('2026-09-06', 150, 'Dining', 'Via Carota'), t('2026-09-12', 150, 'Dining', 'Lilia')]);
    expect(r.flagged).toHaveLength(0);
    expect(r.headlineDriver).toBe(null);
  });

  it('only explains categories that were flagged, never the noise', () => {
    const r = run([t('2026-09-08', 474, 'Clothing', 'H&M')]);
    for (const d of r.drivers) {
      if (d.flagged) expect(d.explain, d.category).toBeTruthy();
      else expect(d.explain, d.category).toBeUndefined();
    }
  });

  it('requires two thirds before it says "most of it"', () => {
    // The threshold is the whole claim. Below it the wording has to change, or "most"
    // becomes a word the reader learns to discount.
    const r = run([t('2026-09-02', 200, 'Dining', 'Lilia'), t('2026-09-04', 190, 'Dining', 'Rezdora'),
      t('2026-09-06', 180, 'Dining', 'Via Carota'), t('2026-09-09', 210, 'Dining', 'Misi'),
      t('2026-09-12', 200, 'Dining', 'Torrisi')]);
    const x = r.headlineDriver.explain;
    expect(x.shareOfOver).toBeLessThan(0.66);
    expect(x.sentence).not.toMatch(/most of it/);
  });

  it('survives transactions with no merchant on them', () => {
    const r = run([t('2026-09-08', 474, 'Clothing', undefined)]);
    expect(() => r.headlineDriver.explain.sentence).not.toThrow();
    expect(r.headlineDriver.explain.merchant).toBe('Uncategorised merchant');
  });
});

describe('the spending alert acts on the difference', () => {
  const t = (date, amount, categoryName, merchant) => ({ date, amount: -amount, categoryName, merchant });
  const build = extra => {
    const txns = [];
    for (const m of ['06', '07', '08']) {
      for (let d = 2; d <= 28; d += 3) txns.push(t(`2026-${m}-${String(d).padStart(2, '0')}`, 120, 'Groceries', 'Whole Foods'));
      txns.push(t(`2026-${m}-06`, 150, 'Dining', 'Via Carota'));
      txns.push(t(`2026-${m}-14`, 60, 'Clothing', 'Uniqlo'));
    }
    for (let d = 2; d <= 14; d += 3) txns.push(t(`2026-09-${String(d).padStart(2, '0')}`, 120, 'Groceries', 'Whole Foods'));
    txns.push(...extra);
    return Monitors.spendingPace({ pace: P.pace(txns, null, { asOf: '2026-09-14' }) });
  };

  it('tells you to do nothing when the cause was a single purchase', () => {
    // A charge that will not repeat needs no behaviour change, and saying otherwise spends
    // attention on a decision that does not exist.
    const a = build([t('2026-09-08', 900, 'Clothing', 'H&M')]).alerts.find(x => x.kind === 'spendingPace');
    expect(a, 'a pace alert').toBeTruthy();
    expect(a.action).toMatch(/not a new pattern/);
    expect(a.driverExplain.kind).toBe('one-off');
    expect(a.significance).toMatch(/one-time H&M purchase/);
  });

  it('names it a pattern when the merchant is a regular', () => {
    const a = build([t('2026-09-03', 500, 'Dining', 'Via Carota'), t('2026-09-09', 450, 'Dining', 'Via Carota')])
      .alerts.find(x => x.kind === 'spendingPace');
    expect(a.driverExplain.kind).toBe('more of the same');
    expect(a.action).toMatch(/a pattern rather than a surprise/);
  });

  it('carries the explanation on the alert so nothing re-derives it', () => {
    // The inbox and the advisor both quote this. Re-deriving it from the ledger in two
    // places is how two surfaces end up giving different answers about the same month.
    const a = build([t('2026-09-08', 900, 'Clothing', 'H&M')]).alerts.find(x => x.kind === 'spendingPace');
    expect(a.driverExplain).toMatchObject({ category: 'Clothing', merchant: 'H&M' });
  });
});

// The headline names WHERE; the row underneath says WHAT. Saying both in both places is how
// a card starts reading like it is repeating itself.
describe('the spending card does not say it twice', () => {
  const html = require('node:fs').readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  it('the headline names the category, the rows explain it', () => {
    expect(html).toContain('<p class="pace-headline-driver">${e(p.headlineDriver.label)}</p>');
    expect(html).toContain('d.explain?`<small class="pace-why"');
  });
  it('drops the explanation onto its own line rather than a third column', () => {
    const css = require('node:fs').readFileSync(new URL('../public/cockpit.css', import.meta.url), 'utf8');
    expect(css).toContain('.pace-driver{flex-wrap:wrap}');
    expect(css).toMatch(/\.pace-why\{flex:1 1 100%/);
  });
});

// ── The band that could not be fallen out of ────────────────────────────────
// On real data this card read "$8,127 · about normal" against a normal range of
// $1,782–$11K — a band 1.4x as wide as the typical it described, built from mean ± one
// standard deviation over twenty-four months. Two faults compounding:
//
//   A standard deviation is inflated by the outliers it is meant to see past, so the more
//   unusual a month was, the less the card notices the next one. And ±1 SD is a coin flip
//   anyway: a third of months sit outside it by construction.
//
// A month running 32% above typical was being called normal.
describe('The normal range is built from the trailing year, robustly',()=>{
  // Twelve ordinary months near $6,000 by the 20th, plus two old blowouts that a standard
  // deviation would never recover from.
  const history=(n,{outliers=[]}={})=>{
    const rows=[];
    for(let i=n;i>=1;i--){
      const d=new Date(Date.UTC(2026,8-i,1)),mk=d.toISOString().slice(0,7);
      const base=6000+((i*211)%400);
      for(let day=1;day<=20;day++)
        rows.push({date:`${mk}-${String(day).padStart(2,'0')}`,amount:-(base/20),categoryName:'Dining'});
      if(outliers.includes(i))rows.push({date:`${mk}-11`,amount:-9000,categoryName:'Charity'});
    }
    return rows;
  };
  const thisMonth=(total)=>Array.from({length:20},(_,i)=>
    ({date:`2026-09-${String(i+1).padStart(2,'0')}`,amount:-(total/20),categoryName:'Dining'}));

  it('reads the last twelve months, not everything on the ledger',()=>{
    // Two years ago is a different household: a baby arriving, income that has moved.
    const p=Pace.pace([...history(24),...thisMonth(6000)],null,{asOf:'2026-09-20'});
    expect(p.monthsCompared).toBe(12);
    expect(p.windowMonths).toBe(12);
  });

  it('takes a shorter window when asked, and everything there is when the ledger is short',()=>{
    expect(Pace.pace([...history(24),...thisMonth(6000)],null,{asOf:'2026-09-20',windowMonths:6}).monthsCompared).toBe(6);
    expect(Pace.pace([...history(5),...thisMonth(6000)],null,{asOf:'2026-09-20'}).monthsCompared).toBe(5);
  });

  it('is not widened by one enormous month in the history',()=>{
    // The whole failure in one assertion: two $9,000 months used to blow the band open far
    // enough that nothing after them could ever be unusual.
    const clean=Pace.pace([...history(12),...thisMonth(6000)],null,{asOf:'2026-09-20'});
    const spiked=Pace.pace([...history(12,{outliers:[3,8]}),...thisMonth(6000)],null,{asOf:'2026-09-20'});
    const width=p=>p.normalHigh-p.normalLow;
    expect(width(spiked)).toBeLessThan(width(clean)*2);
    expect(Math.abs(spiked.typical-clean.typical)).toBeLessThan(clean.typical*0.1);
  });

  it('keeps the range narrower than the figure it describes',()=>{
    // $1,782–$10,516 around a typical of $6,149 was not a range anyone could fall outside.
    const p=Pace.pace([...history(12,{outliers:[3,8]}),...thisMonth(6000)],null,{asOf:'2026-09-20'});
    expect(p.normalHigh-p.normalLow).toBeLessThan(p.typical);
  });

  it('calls a month running a third above typical what it is',()=>{
    const p=Pace.pace([...history(12),...thisMonth(8100)],null,{asOf:'2026-09-20'});
    expect(p.over/p.typical).toBeGreaterThan(0.25);
    expect(['above','well above']).toContain(p.verdict);
    expect(p.tone).not.toBe('neutral');
  });

  it('still calls an ordinary month ordinary',()=>{
    const p=Pace.pace([...history(12),...thisMonth(6150)],null,{asOf:'2026-09-20'});
    expect(p.verdict).toBe('about');
    expect(p.tone).toBe('neutral');
  });

  it('says how many of the window this month is running above, which needs no trust',()=>{
    const p=Pace.pace([...history(12),...thisMonth(20000)],null,{asOf:'2026-09-20'});
    expect(p.monthsAbove).toBe(12);
    expect(p.rank).toBe(1);
    expect(p.verdict).toBe('well above');
  });

  it('does not tell a steady household that sixty dollars is a finding',()=>{
    // Percentiles alone would make a household whose months barely vary permanently alarmed.
    const flat=[];
    for(let i=12;i>=1;i--){
      const mk=new Date(Date.UTC(2026,8-i,1)).toISOString().slice(0,7);
      for(let d=1;d<=20;d++)flat.push({date:`${mk}-${String(d).padStart(2,'0')}`,amount:-100,categoryName:'Dining'});
    }
    const p=Pace.pace([...flat,...thisMonth(2060)],null,{asOf:'2026-09-20'});
    expect(p.normalHigh-p.normalLow).toBeGreaterThanOrEqual(200);   // a floor under the band
    expect(p.verdict).toBe('about');
  });
});

describe('The statistics behind it',()=>{
  it('interpolates percentiles rather than picking the nearest sample',()=>{
    expect(Pace.percentile([1,2,3,4,5,6,7,8,9,10],0.5)).toBeCloseTo(5.5,6);
    expect(Pace.percentile([1,2,3,4,5,6,7,8,9,10],0.2)).toBeCloseTo(2.8,6);
    expect(Pace.percentile([],0.5)).toBe(0);
    expect(Pace.percentile([7],0.9)).toBe(7);
  });

  it('uses a median that one huge month cannot move',()=>{
    expect(Pace.median([100,110,105,95,2500])).toBe(105);
    expect(Pace.mean([100,110,105,95,2500])).toBeGreaterThan(500);   // what it used to use
  });

  it('counts a tie as half, so an exactly typical month reads as the middle',()=>{
    expect(Pace.rankOf(5,[5,5,5,5])).toBe(0.5);
    expect(Pace.rankOf(9,[1,2,3])).toBe(1);
    expect(Pace.rankOf(0,[1,2,3])).toBe(0);
    expect(Pace.rankOf(5,[])).toBe(0.5);
  });

  it('bands on rank among prior months, not on standard deviations',()=>{
    expect(Pace.bandFor(0.5).verdict).toBe('about');
    expect(Pace.bandFor(0.95).verdict).toBe('well above');
    expect(Pace.bandFor(0.05).verdict).toBe('well below');
  });
});

describe('The card says what the range actually is',()=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');

  it('calls the centre typical, not "the middle of that range"',()=>{
    expect(html).toContain('above typical`');
    expect(html).not.toContain('above the middle of that range');
  });

  it('prints the count of months it is running above',()=>{
    expect(html).toContain('running above <b>${p.monthsAbove} of your last ${p.monthsCompared}</b>');
  });

  it('explains what the band is instead of asserting "normal"',()=>{
    expect(html).toContain('the range is where the middle ${Math.round((p.bandPct[1]-p.bandPct[0])*100)}% of them landed');
    expect(html).not.toContain('Compared against the same day of ${p.monthsCompared} earlier month');
  });
});

// A card that draws a month inside the range it labels normal and calls it "well above" in
// the same breath has told the reader to trust neither half.
describe('The range drawn is the verdict',()=>{
  const steady=(perDay)=>{
    const rows=[];
    for(let i=12;i>=1;i--){
      const mk=new Date(Date.UTC(2026,8-i,1)).toISOString().slice(0,7);
      for(let d=1;d<=20;d++)rows.push({date:`${mk}-${String(d).padStart(2,'0')}`,amount:-perDay,categoryName:'Dining'});
    }
    return rows;
  };
  const now=(total)=>Array.from({length:20},(_,i)=>
    ({date:`2026-09-${String(i+1).padStart(2,'0')}`,amount:-(total/20),categoryName:'Dining'}));

  it('never calls a month inside the drawn range anything but normal',()=>{
    // Rank alone said "well above": every month of an identical history is above all twelve
    // of its predecessors by a few dollars, so rank hits 1.0 on sixty dollars.
    const p=Pace.pace([...steady(100),...now(2060)],null,{asOf:'2026-09-20'});
    expect(p.rank).toBe(1);
    expect(p.mtd).toBeLessThanOrEqual(p.normalHigh);
    expect(p.verdict).toBe('about');
  });

  it('never calls a month outside the drawn range normal',()=>{
    for (const total of [3200, 900]) {
      const p=Pace.pace([...steady(100),...now(total)],null,{asOf:'2026-09-20'});
      const outside=p.mtd>p.normalHigh||p.mtd<p.normalLow;
      expect(outside).toBe(true);
      expect(p.verdict).not.toBe('about');
    }
  });

  it('holds across a spread of months, in both directions',()=>{
    for(const total of [500,1500,1900,2000,2100,2500,6000,20000]){
      const p=Pace.pace([...steady(100),...now(total)],null,{asOf:'2026-09-20'});
      const inside=p.mtd>=p.normalLow&&p.mtd<=p.normalHigh;
      expect(p.verdict==='about').toBe(inside);
      expect(p.tone==='neutral').toBe(inside);
    }
  });
});
