import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const TP=require('../public/tax-plan.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const R=M.run(D).R;

describe('Safe harbour is the statutory test, not the tax bill',()=>{
  it('takes the cheaper of 90% of this year and 110% of last',()=>{
    const s=TP.safeHarbour({projectedLiability:400000,priorYearLiability:200000,priorYearAGI:900000});
    expect(s.currentYearRoute).toBe(360000);
    expect(s.priorYearRoute).toBeCloseTo(220000,6);
    expect(s.required).toBeCloseTo(220000,6);
    expect(s.cheaperRoute).toBe('prior year');
    expect(s.citation).toBe('IRC § 6654(d)(1)(B)-(C)');
  });

  it('uses 100% of last year below the $150,000 AGI line',()=>{
    const s=TP.safeHarbour({projectedLiability:400000,priorYearLiability:200000,priorYearAGI:120000});
    expect(s.priorYearShareUsed).toBe(1.00);
    expect(s.required).toBe(200000);
  });

  it('assumes the stricter 110% when prior AGI is unknown, and says it assumed',()=>{
    const s=TP.safeHarbour({projectedLiability:400000,priorYearLiability:200000});
    expect(s.priorYearShareUsed).toBe(1.10);
    expect(s.priorAGIAssumed).toBe(true);
    expect(s.needs.some(n=>n.field==='priorYearAGI')).toBe(true);
  });

  it('asks for last year\'s return rather than guessing at it',()=>{
    const s=TP.safeHarbour({projectedLiability:400000});
    expect(s.priorYearRoute).toBe(null);
    expect(s.required).toBe(360000);          // falls back to the only route it can compute
    const n=s.needs.find(x=>x.field==='priorYearLiability');
    expect(n.document).toBe(TP.DOC.PRIOR_RETURN);
    expect(n.why).toMatch(/Form 1040/);
  });

  it('never claims the safe harbour reduces the tax owed',()=>{
    const s=TP.safeHarbour({projectedLiability:400000,priorYearLiability:200000,priorYearAGI:900000});
    expect(s.note).toMatch(/does NOT reduce the tax/);
  });
});

describe('Liability against what has actually been paid',()=>{
  const base={projectedLiability:420000,priorYearLiability:300000,priorYearAGI:1100000,
    asOf:'2026-08-15'};

  it('refuses to compare anything without the withholding figure',()=>{
    const s=TP.withholdingStatus({projectedLiability:420000,asOf:'2026-08-15'});
    expect(s.status).toBe('incomplete');
    const n=s.needs.find(x=>x.field==='withheldToDate');
    expect(n.document).toBe(TP.DOC.PAYSTUB_YTD);
    expect(s.shortfallVsHarbour).toBe(undefined);   // no number is invented
  });

  it('keeps the safe-harbour shortfall and the tax still owed apart',()=>{
    const s=TP.withholdingStatus({...base,withheldToDate:200000});
    expect(s.status).toBe('ok');
    expect(s.safeHarbour.required).toBeCloseTo(330000,6);   // 110% of 300k < 90% of 420k
    expect(s.shortfallVsHarbour).toBeCloseTo(130000,6);
    expect(s.shortfallVsLiability).toBeCloseTo(220000,6);
    // The two must be named separately, because confusing them is the whole trap.
    expect(s.interpretation).toMatch(/short of the safe harbour/);
    expect(s.interpretation).toMatch(/does not make that go away/);
  });

  it('says the safe harbour is met while still flagging what is due in April',()=>{
    const s=TP.withholdingStatus({...base,withheldToDate:340000});
    expect(s.shortfallVsHarbour).toBe(0);
    expect(s.shortfallVsLiability).toBeCloseTo(80000,6);
    expect(s.interpretation).toMatch(/no underpayment charge/);
    expect(s.interpretation).toMatch(/set it aside/);
    expect(s.quarterlyPayment).toBe(0);
  });

  it('spreads the shortfall over the instalments that are actually left',()=>{
    // Mid-August: Q1 and Q2 have passed, Q3 and Q4 remain.
    const s=TP.withholdingStatus({...base,withheldToDate:200000});
    expect(s.remaining.map(q=>q.label)).toEqual(['Q3','Q4']);
    expect(s.quarterlyPayment).toBeCloseTo(65000,6);
    expect(s.nextInstalment.due).toBe('2026-09-15');
  });

  it('says withholding can still cure an earlier quarter and an estimate cannot',()=>{
    const s=TP.withholdingStatus({...base,withheldToDate:200000});
    expect(s.remedy).toMatch(/6654\(g\)/);
    expect(s.remedy).toMatch(/estimated payment cannot/);
  });

  it('stops offering instalments once none are left',()=>{
    // Planning the 2026 year from February 2027: every 2026 instalment date has gone.
    const s=TP.withholdingStatus({...base,withheldToDate:200000,asOf:'2027-02-01',taxYear:2026});
    expect(s.remaining).toEqual([]);
    expect(s.quarterlyPayment).toBe(0);
    expect(s.remedy).toMatch(/due with the return/);
  });

  it('projects the year-end gap from the pace of withholding so far',()=>{
    const s=TP.withholdingStatus({...base,withheldToDate:210000,asOf:'2026-07-02'});
    // Half the year gone, $210K withheld → about $420K for the year, so no gap.
    expect(s.projectedWithholding).toBeGreaterThan(400000);
    expect(s.projectedYearEndGap).toBeLessThan(30000);
  });

  it('will not extrapolate a run rate from the first week of January',()=>{
    const s=TP.withholdingStatus({...base,withheldToDate:5000,asOf:'2026-01-05'});
    expect(s.projectedWithholding).toBe(null);
    expect(s.projectedYearEndGap).toBe(null);
  });
});

describe('Opportunity screening separates arithmetic from eligibility',()=>{
  const ctx={P:{...D,pretax401k:20000,elective401kLimit:24500,
    stripeVestWithholdingRate:0.403},R,marginalRate:0.45};

  it('labels every item with a confidence, and never blends the two',()=>{
    for(const o of TP.screenOpportunities(ctx)){
      expect(Object.values(TP.CONFIDENCE),o.id).toContain(o.confidence);
      if(o.confidence===TP.CONFIDENCE.REQUIRES_CONFIRMATION)
        expect(o.eligibility.length,`${o.id} needs confirmation but lists no eligibility test`).toBeGreaterThan(0);
    }
  });

  it('prices unused deferral room, showing the rate it used',()=>{
    const o=TP.screenOpportunities(ctx).find(x=>x.id==='deferralRoom');
    expect(o.confidence).toBe(TP.CONFIDENCE.ESTIMATE);
    expect(o.estimatedSaving).toBeCloseTo(4500*0.45,6);
    expect(o.basis).toMatch(/45\.0%/);
    expect(o.assumptions.join(' ')).toMatch(/deferred, not forgiven/);
    expect(o.source).toMatch(/Notice 2025-67/);
  });

  it('catches the vest under-withholding and calls it a liability, not a saving',()=>{
    const o=TP.screenOpportunities(ctx).find(x=>x.id==='vestUnderWithholding');
    expect(o).toBeTruthy();
    expect(o.estimatedSaving).toBe(null);
    expect(o.liability).toBeGreaterThan(0);
    expect(o.action).toMatch(/withholding rather than an estimated payment/);
  });

  it('asks for a vest paystub when the real rate is unknown',()=>{
    const o=TP.screenOpportunities({...ctx,P:{...ctx.P,stripeVestWithholdingRate:null}})
      .find(x=>x.id==='vestWithholdingUnknown');
    expect(o.needs[0].document).toBe(TP.DOC.VEST_PAYSTUB);
  });

  it('assigns QSBS no value at all, and says why',()=>{
    const o=TP.screenOpportunities(ctx).find(x=>x.id==='qsbs');
    expect(o.confidence).toBe(TP.CONFIDENCE.REQUIRES_CONFIRMATION);
    expect(o.estimatedSaving).toBe(null);
    expect(o.action).toMatch(/Do not plan around it/);
    // The three facts that actually decide it.
    const e=o.eligibility.join(' ');
    expect(e).toMatch(/ORIGINAL ISSUE/);
    expect(e).toMatch(/five-year/);
    expect(e).toMatch(/New York State does not conform/);
  });

  it('will not claim a harvestable loss without lot basis',()=>{
    const o=TP.screenOpportunities(ctx).find(x=>x.id==='lossHarvesting');
    expect(o.estimatedSaving).toBe(null);
    expect(o.needs[0].document).toBe(TP.DOC.BASIS_STATEMENT);
    expect(o.eligibility.join(' ')).toMatch(/wash-sale/);
  });

  it('stays quiet about deferral room when the limit is already met',()=>{
    const full={...ctx,P:{...ctx.P,pretax401k:24500}};
    expect(TP.screenOpportunities(full).some(o=>o.id==='deferralRoom')).toBe(false);
  });

  it('produces the same list twice for the same picture',()=>{
    const a=TP.screenOpportunities(ctx).map(o=>o.id);
    const b=TP.screenOpportunities(ctx).map(o=>o.id);
    expect(a).toEqual(b);
  });
});

describe('Extracted document values are reviewed before they are used',()=>{
  const staged=TP.stageExtraction(TP.DOC.VEST_PAYSTUB,[
    {field:'grossVest',label:'Gross vest value',value:197000,locator:'Earnings — RSU VEST'},
    {field:'federalWithheld',label:'Federal withheld',value:43340,locator:'Taxes — FED'},
    {field:'stateWithheld',label:'NY State withheld',value:23049,locator:'Taxes — NY'},
  ],{filename:'vest-2026-08.pdf'});

  it('starts with nothing accepted, and shows where each value came from',()=>{
    expect(staged.status).toBe('awaitingReview');
    for(const f of staged.fields){
      expect(f.accepted).toBe(false);
      expect(f.locator).toBeTruthy();
    }
  });

  it('hands back nothing at all until a value is accepted',()=>{
    const r=TP.applyReview(staged,{});
    expect(r.accepted).toEqual({});
    expect(r.pending).toHaveLength(3);
    expect(r.complete).toBe(false);
  });

  it('never treats an undecided field as accepted',()=>{
    const r=TP.applyReview(staged,{grossVest:{accepted:true}});
    expect(r.accepted).toEqual({grossVest:197000});
    expect(r.pending).toEqual(['federalWithheld','stateWithheld']);
    expect(r.complete).toBe(false);
  });

  it('takes a correction over the extracted value',()=>{
    const r=TP.applyReview(staged,{
      grossVest:{accepted:true,corrected:196500},
      federalWithheld:{accepted:true},
      stateWithheld:{accepted:false},
    });
    expect(r.accepted.grossVest).toBe(196500);
    expect(r.accepted.federalWithheld).toBe(43340);
    expect(r.rejected).toEqual(['stateWithheld']);
    expect(r.complete).toBe(true);
    expect(r.status).toBe('reviewed');
  });
});

describe('Only the documents actually needed are requested',()=>{
  it('groups requests by document so one page is asked for once',()=>{
    const s=TP.withholdingStatus({projectedLiability:420000,asOf:'2026-08-15'});
    const reqs=TP.documentRequests(s.needs);
    const prior=reqs.find(r=>r.document===TP.DOC.PRIOR_RETURN);
    expect(prior.fields.sort()).toEqual(['priorYearAGI','priorYearLiability']);
    expect(prior.reasons.length).toBeGreaterThan(0);
    expect(prior.label).toMatch(/Form 1040/);
  });

  it('asks for nothing when nothing is missing',()=>{
    const s=TP.withholdingStatus({projectedLiability:420000,withheldToDate:400000,
      priorYearLiability:300000,priorYearAGI:1100000,asOf:'2026-08-15'});
    expect(s.needs).toEqual([]);
    expect(TP.documentRequests(s.needs)).toEqual([]);
  });
});
