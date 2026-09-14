import { describe, it, expect } from 'vitest';
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
