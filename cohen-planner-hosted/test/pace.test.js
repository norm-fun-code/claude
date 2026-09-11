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
