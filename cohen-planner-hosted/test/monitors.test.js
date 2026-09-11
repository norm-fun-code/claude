import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const M0=require('../public/monitors.js');
const Liq=require('../public/liquidity.js');
const Rules=require('../public/tax-rules.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');

const base=(over={})=>{
  const P={...D,...over};
  return{P,R:M.run(P).R,liquidity:Liq,taxRules:Rules,today:'2026-09-10'};
};
const titles=out=>out.alerts.map(a=>a.title);
const kinds=out=>out.alerts.map(a=>a.kind);

describe('An alert is a measurement, not an opinion',()=>{
  it('reports nothing when nothing is wrong',()=>{
    const ctx=base({liquidReserveFloor:0,homePurchaseYear:9999,concentrationThreshold:null});
    const out=M0.reserveFloor(ctx);
    expect(out.alerts).toEqual([]);
  });

  it('gives every alert evidence, significance and an action',()=>{
    const ctx=base({liquidReserveFloor:5000000});
    const out=M0.detect(ctx);
    expect(out.alerts.length).toBeGreaterThan(0);
    for(const a of out.alerts){
      expect(a.key,a.title).toBeTruthy();
      expect(a.evidence.length,a.title).toBeGreaterThan(0);
      for(const e of a.evidence){
        expect(e.label,a.title).toBeTruthy();
        expect(e.value,a.title).not.toBe(undefined);
        expect(e.source,`${a.title} / ${e.label} has no source`).toBeTruthy();
      }
      expect(a.significance,a.title).toBeTruthy();
      expect(a.action,a.title).toBeTruthy();
      expect(Object.values(M0.SEVERITY)).toContain(a.severity);
    }
  });

  it('keeps a key that survives re-running, so a dismissal sticks',()=>{
    const ctx=base({liquidReserveFloor:5000000});
    const a=M0.detect(ctx).alerts.map(x=>x.key).sort();
    const b=M0.detect({...ctx,today:'2026-11-20'}).alerts.map(x=>x.key).sort();
    expect(a).toEqual(b);
    // And no key carries a timestamp or a dollar figure that would break that.
    for(const k of a)expect(k,k).not.toMatch(/\d{4}-\d{2}-\d{2}|\$/);
  });
});

describe('A monitor that cannot run says so',()=>{
  it('does not silently report "all clear" when the data is missing',()=>{
    const out=M0.detect({today:'2026-09-10'});      // no plan, no results, nothing
    expect(out.alerts).toEqual([]);
    expect(out.skipped.length).toBeGreaterThan(0);
    for(const s of out.skipped)expect(s.missing,JSON.stringify(s)).toBeTruthy();
    // The distinction the whole design rests on.
    expect(M0.briefingInput(out,M0.prioritize(out.alerts,{},{})).complete).toBe(false);
  });

  it('will not measure concentration against a threshold the user never chose',()=>{
    const ctx=base({concentrationThreshold:null});
    const out=M0.concentration(ctx);
    expect(out.alerts).toEqual([]);
    expect(out.skipped[0].missing).toBe('concentrationThreshold');
    expect(out.skipped[0].reason).toBe(M0.SKIP.NOT_CONFIGURED);
  });

  it('refuses to difference an incomplete balance sheet',()=>{
    const ctx={...base(),accounts:{netWorth:900000,complete:false}};
    const out=M0.divergence(ctx);
    expect(out.alerts.filter(a=>a.key.includes('netWorth'))).toEqual([]);
    expect(out.skipped.some(s=>/missing/.test(s.note||''))).toBe(true);
  });

  it('will not average spending from fewer than three complete months',()=>{
    const ctx={...base(),spending:{completeMonths:['2026-07','2026-08'],monthlyExpense:99000}};
    const out=M0.divergence(ctx);
    expect(out.alerts.filter(a=>a.key.includes('spending'))).toEqual([]);
    expect(out.skipped.some(s=>/3 complete months/.test(s.missing))).toBe(true);
  });

  it('counts a crashed check as unknown, never as clear',()=>{
    // A getter that throws stands in for any monitor blowing up on odd data.
    const ctx=base();
    Object.defineProperty(ctx,'accounts',{get(){throw new Error('boom')}});
    const out=M0.detect(ctx);
    expect(out.failed.length).toBeGreaterThan(0);
    expect(out.checksRun).toBeLessThan(out.checksTotal);
    expect(M0.briefingInput(out,M0.prioritize(out.alerts,{},{})).complete).toBe(false);
  });
});

describe('Reserve floor',()=>{
  it('reports the worst year once, not every year separately',()=>{
    const ctx=base({liquidReserveFloor:5000000});
    const out=M0.reserveFloor(ctx);
    expect(out.alerts).toHaveLength(1);
    const a=out.alerts[0];
    const worst=ctx.R.reduce((x,y)=>y.liq<x.liq?y:x);
    expect(a.evidence.some(e=>e.value.includes(String(worst.yr))||a.title.includes(String(worst.yr)))).toBe(true);
  });

  it('separates dipping below the floor from running out of money entirely',()=>{
    const dip=M0.reserveFloor(base({liquidReserveFloor:5000000})).alerts[0];
    expect(dip.severity).toBe(M0.SEVERITY.WARNING);

    const broke={...D,startingLiquid:0,startingStripeEquity:0,liquidReserveFloor:500000,
      homePurchaseYear:2027,homePrice:6000000,nycRent:20000};
    for(let i=0;i<11;i++){broke['normCashY'+i]=60000;broke['normStockY'+i]=0}
    const out=M0.reserveFloor({P:broke,R:M.run(broke).R,today:'2026-09-10'});
    expect(out.alerts[0].severity).toBe(M0.SEVERITY.CRITICAL);
    expect(out.alerts[0].title).toMatch(/negative/);
  });
});

describe('Home funding against the tender calendar',()=>{
  it('flags a purchase the annual model funds but the calendar does not',()=>{
    // Everything rides on Stripe, and the close is in a quarter with no tender.
    const P={...D,homePurchaseYear:2028,homePrice:4000000,downPctg:25,
      // Closing in Q3 with the only tender in Q4: nothing but the standing quarterly
      // election is reachable before the cheque clears.
      homePurchaseQuarter:3,startingLiquid:100000,startingStripeEquity:3000000,
      liquidReserveFloor:100000,stripeTenderQuarters:[4]};
    const out=M0.homeFunding({P,R:M.run(P).R,liquidity:Liq,today:'2026-09-10'});
    const a=out.alerts.find(x=>x.key.includes('shortfall'));
    expect(a).toBeTruthy();
    expect(a.severity).toBe(M0.SEVERITY.CRITICAL);
    expect(a.action).toBeTruthy();
    // It must say which quarter, since that is the whole finding.
    expect(a.evidence.some(e=>/Q3/.test(e.value))).toBe(true);
  });

  it('still warns when it clears but leans on stock',()=>{
    const P={...D,homePurchaseYear:2028,homePrice:3000000,downPctg:20,
      homePurchaseQuarter:1,startingLiquid:200000,startingStripeEquity:4000000,
      liquidReserveFloor:100000};
    const out=M0.homeFunding({P,R:M.run(P).R,liquidity:Liq,today:'2026-09-10'});
    const a=out.alerts[0];
    expect(a.key).toContain('stockDependent');
    expect(a.severity).toBe(M0.SEVERITY.WARNING);
  });

  it('says nothing when the portfolio covers the purchase outright',()=>{
    const P={...D,homePurchaseYear:2028,homePrice:1500000,downPctg:20,
      startingLiquid:8000000,startingStripeEquity:0,liquidReserveFloor:100000};
    const out=M0.homeFunding({P,R:M.run(P).R,liquidity:Liq,today:'2026-09-10'});
    expect(out.alerts).toEqual([]);
  });

  it('marks an assumed closing quarter as assumed',()=>{
    const P={...D,homePurchaseYear:2028,homePrice:4000000,downPctg:25,
      startingLiquid:50000,startingStripeEquity:3000000,liquidReserveFloor:50000,
      stripeTenderQuarters:[4]};
    delete P.homePurchaseQuarter;
    const out=M0.homeFunding({P,R:M.run(P).R,liquidity:Liq,today:'2026-09-10'});
    if(out.alerts.length)
      expect(JSON.stringify(out.alerts[0].evidence)).toMatch(/assumed/);
  });
});

describe('Concentration is measured against the user\'s own limit',()=>{
  it('alerts when live balances exceed the chosen share',()=>{
    const ctx={...base({concentrationThreshold:0.4}),
      accounts:{netWorth:2000000,stripeVested:1400000,complete:true}};
    const a=M0.concentration(ctx).alerts.find(x=>x.key.includes('over'));
    expect(a).toBeTruthy();
    expect(a.title).toMatch(/70\.0%/);
    expect(a.evidence.some(e=>e.source==='live account balances')).toBe(true);
    // It must quantify the way back, not just complain.
    expect(a.action).toMatch(/\$/);
  });

  it('prefers live balances over the projection when both exist',()=>{
    const ctx={...base({concentrationThreshold:0.4}),
      accounts:{netWorth:2000000,stripeVested:1400000,complete:true}};
    const a=M0.concentration(ctx).alerts[0];
    expect(a.evidence.find(e=>e.label==='Stripe position').source).toBe('live account balances');
  });

  it('gives notice before the limit is crossed, not only after',()=>{
    const ctx=base({concentrationThreshold:0.99,stripePolicy:'retain',startingStripeEquity:100000});
    const out=M0.concentration(ctx);
    for(const a of out.alerts)expect(a.severity).not.toBe(M0.SEVERITY.CRITICAL);
  });
});

describe('Deadlines are computed, never remembered',()=>{
  it('does not invent an estimated-tax payment without withholding figures',()=>{
    const out=M0.deadlines({P:D,today:'2026-09-01'});
    expect(out.alerts.filter(a=>a.key.includes('estimatedTax'))).toEqual([]);
    expect(out.skipped.some(s=>/withholding/.test(s.missing))).toBe(true);
  });

  it('raises the instalment when one is genuinely owed, and escalates as it nears',()=>{
    const taxPlan={quarterlyPayment:42000,projectedLiability:210000,withheldToDate:120000};
    const far=M0.deadlines({P:D,today:'2026-08-20',taxPlan}).alerts.find(a=>a.key.includes('estimatedTax'));
    const near=M0.deadlines({P:D,today:'2026-09-08',taxPlan}).alerts.find(a=>a.key.includes('estimatedTax'));
    expect(far.severity).toBe(M0.SEVERITY.WARNING);
    expect(near.severity).toBe(M0.SEVERITY.CRITICAL);
    expect(near.key).toBe(far.key);            // same condition, same key
  });

  it('stays quiet when nothing is owed',()=>{
    const out=M0.deadlines({P:D,today:'2026-09-08',
      taxPlan:{quarterlyPayment:0,projectedLiability:210000,withheldToDate:230000}});
    expect(out.alerts.filter(a=>a.key.includes('estimatedTax'))).toEqual([]);
  });

  it('flags unused deferral room only while it can still be used',()=>{
    const P={...D,pretax401k:20000,elective401kLimit:24500};
    const inTime=M0.deadlines({P,today:'2026-10-01'}).alerts.find(a=>a.key.includes('deferral'));
    expect(inTime).toBeTruthy();
    expect(inTime.title).toMatch(/\$4,500/);
    // In March there is nothing urgent about it, so it does not take up a slot.
    expect(M0.deadlines({P,today:'2026-03-01'}).alerts.filter(a=>a.key.includes('deferral'))).toEqual([]);
  });
});

describe('Decision review fires on the condition, not on the passage of time',()=>{
  const decision={id:'d1',title:'Hold Stripe rather than diversify',status:'active',
    decidedAt:'2026-03-01',rationale:'A tender in Q1 2027 is expected at a higher mark.',
    reconsiderWhen:[{id:'c1',metric:'stripeShare',op:'gt',value:0.6,
      description:'Stripe passes 60% of net worth'}]};

  it('re-opens a decision when its own stated condition is met',()=>{
    const ctx={...base(),decisions:[decision],
      accounts:{netWorth:2000000,stripeVested:1400000,complete:true}};
    const a=M0.decisionReview(ctx).alerts[0];
    expect(a.title).toMatch(/Revisit/);
    expect(a.evidence.find(e=>e.label==='Because').value).toBe(decision.rationale);
    expect(a.evidence.find(e=>e.label==='Now').value).toBe('70.0%');
  });

  it('leaves it alone when the condition is not met',()=>{
    const ctx={...base(),decisions:[decision],
      accounts:{netWorth:2000000,stripeVested:400000,complete:true}};
    expect(M0.decisionReview(ctx).alerts).toEqual([]);
  });

  it('reports an uncheckable condition rather than treating it as satisfied or not',()=>{
    const d={...decision,reconsiderWhen:[{id:'c2',metric:'inflationExpectation',op:'gt',
      value:0.05,description:'inflation expectations exceed 5%'}]};
    const out=M0.decisionReview({...base(),decisions:[d]});
    expect(out.alerts).toEqual([]);
    expect(out.skipped[0].note).toMatch(/should be revisited/);
  });

  it('ignores decisions that are no longer active',()=>{
    const ctx={...base(),decisions:[{...decision,status:'superseded'}],
      accounts:{netWorth:2000000,stripeVested:1900000,complete:true}};
    expect(M0.decisionReview(ctx).alerts).toEqual([]);
  });
});

describe('Dedup, state and the three-item limit',()=>{
  const mk=(key,severity,year)=>({key,kind:'x',severity,title:key,evidence:[],
    significance:'s',action:'a',year});

  it('collapses repeats and counts them',()=>{
    const out=M0.dedupe([mk('a','warning'),mk('a','warning'),mk('b','info')]);
    expect(out).toHaveLength(2);
    expect(out.find(x=>x.key==='a').occurrences).toBe(2);
  });

  it('shows at most three, and keeps the rest available',()=>{
    const alerts=['a','b','c','d','e'].map(k=>mk(k,'warning'));
    const p=M0.prioritize(alerts,{},{today:'2026-09-10'});
    expect(p.priorities).toHaveLength(3);
    expect(p.more).toHaveLength(2);
    expect(p.counts.open).toBe(5);
  });

  it('ranks critical first, then by how soon it lands',()=>{
    const p=M0.prioritize([mk('far','critical',2049),mk('info','info',2027),
      mk('soon','critical',2027),mk('warn','warning',2027)],{},{today:'2026-09-10'});
    expect(p.priorities.map(a=>a.key)).toEqual(['soon','far','warn']);
  });

  it('honours dismiss and resolve, and lets a snooze expire',()=>{
    const alerts=[mk('a','critical',2027),mk('b','warning',2028),mk('c','warning',2029)];
    const states={
      a:{state:'dismissed',since:'2026-09-01'},
      b:{state:'snoozed',until:'2026-12-01'},
      c:{state:'resolved',since:'2026-09-01'},
    };
    const now=M0.prioritize(alerts,states,{today:'2026-09-10'});
    expect(now.priorities).toEqual([]);
    expect(now.counts.suppressed).toBe(3);

    // Once the snooze runs out, b is open again — but a and c stay suppressed.
    const later=M0.prioritize(alerts,states,{today:'2027-01-05'});
    expect(later.priorities.map(x=>x.key)).toEqual(['b']);
    expect(later.priorities[0].wasSnoozedUntil).toBe('2026-12-01');
  });
});

describe('What the advisor is handed',()=>{
  it('carries the gaps and failures, not just the findings',()=>{
    const ctx=base({liquidReserveFloor:5000000,concentrationThreshold:null});
    const det=M0.detect(ctx);
    const input=M0.briefingInput(det,M0.prioritize(det.alerts,{},{today:ctx.today}));
    expect(input.priorities.length).toBeGreaterThan(0);
    expect(input.notChecked.length).toBeGreaterThan(0);
    expect(input.complete).toBe(false);
    expect(input.checksRun).toBe(input.checksTotal);
    // Every priority it may talk about is fully evidenced.
    for(const a of input.priorities)expect(a.evidence.length).toBeGreaterThan(0);
  });

  it('discloses when valuation dates cannot be compared',()=>{
    // A purchase inside the horizon, funded entirely from the portfolio, so the home check
    // genuinely runs and genuinely finds nothing.
    const ctx={...base({liquidReserveFloor:0,homePurchaseYear:2030,homePrice:1200000,
      downPctg:20,startingLiquid:12000000,startingStripeEquity:0,concentrationThreshold:0.9,
      pretax401k:24500,elective401kLimit:24500}),
      accounts:{netWorth:0,complete:true},
      spending:{completeMonths:['2026-05','2026-06','2026-07'],monthlyExpense:0},
      taxPlan:{quarterlyPayment:0,projectedLiability:0,withheldToDate:0},
      decisions:[]};
    ctx.R=M.run(ctx.P).R;
    const det=M0.detect(ctx);
    const input=M0.briefingInput(det,M0.prioritize(det.alerts,{},{today:ctx.today}));
    expect(det.failed).toEqual([]);
    expect(input.notChecked.some(s=>s.missing==='matching valuation date and asset scope')).toBe(true);
    expect(input.complete).toBe(false);
  });
});
