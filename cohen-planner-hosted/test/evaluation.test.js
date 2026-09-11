import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const Tools=require('../public/advisor-tools.js');
const Monitors=require('../public/monitors.js');
const TaxPlan=require('../public/tax-plan.js');
const TaxRules=require('../public/tax-rules.js');
const Liq=require('../public/liquidity.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const P=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');

// ═══ EVALUATION ═══
// These are not unit tests of a function. They are the real questions this household asks,
// run end to end through the same path the advisor uses, asserting that the ANSWER is
// sound — traceable to an input, honest about what is missing, and never inventing a figure
// to make itself feel complete.

describe('Realistic household questions',()=>{
  it('"can we afford a $3M house?" is answered with measured outcomes, not an opinion',()=>{
    const c=Tools.compareAlternatives({P,alternatives:[
      {name:'Current plan',overrides:{}},
      {name:'$3M house',overrides:{homePrice:3000000}},
    ],metrics:['liquidFloor','liquidFloorYear','drawYears','finalNetWorth','downPayment']});
    expect(c.error).toBe(undefined);
    // Every figure traces back to the engine, not to the comparison layer.
    const truth=M.run({...P,homePrice:3000000});
    const alt=c.alternatives.find(a=>a.name==='$3M house');
    expect(alt.metrics.liquidFloor.value).toBe(Math.min(...truth.R.map(r=>r.liq)));
    expect(alt.metrics.downPayment.value).toBe(truth.dp);
    // And the comparison leads with what the two actually disagree about.
    expect(c.comparison[0].spread).toBeGreaterThan(0);
    expect(c.sharedAssumptions.portfolioReturn).toBe(P.investReturn);
  });

  it('"what if returns are worse?" keeps the changed assumption visible',()=>{
    const c=Tools.compareAlternatives({P,alternatives:[
      {name:'6%',overrides:{investReturn:0.06}},{name:'3%',overrides:{investReturn:0.03}},
    ]});
    expect(c.differingAssumptions.map(d=>d.assumption)).toContain('portfolioReturn');
    expect(c.note).toMatch(/do not share every assumption/);
  });

  it('"should I sell Stripe at the next tender?" gets a comparison, not a prediction',()=>{
    const c=Tools.compareAlternatives({P,alternatives:[
      {name:'Hold everything',overrides:{stripePolicy:'retain'}},
      {name:'Sell 30% each year',overrides:{stripePolicy:'pct',stripeSellPct:0.30}},
    ],metrics:['peakStripeShare','liquidFloor','finalNetWorth','taxOnStockSales']});
    const hold=c.alternatives.find(a=>a.name==='Hold everything');
    const sell=c.alternatives.find(a=>a.name==='Sell 30% each year');
    // Selling must reduce concentration — if it does not, the comparison is broken.
    expect(sell.metrics.peakStripeShare.value).toBeLessThan(hold.metrics.peakStripeShare.value);
    // And the retention policy difference is disclosed rather than buried.
    expect(c.differingAssumptions.map(d=>d.assumption)).toContain('stripePolicy');
  });

  it('"am I withholding enough?" refuses to answer without the paystub',()=>{
    const s=TaxPlan.withholdingStatus({projectedLiability:M.run(P).R[0].tax,asOf:'2026-09-10'});
    expect(s.status).toBe('incomplete');
    expect(TaxPlan.documentRequests(s.needs).map(r=>r.document))
      .toContain(TaxPlan.DOC.PAYSTUB_YTD);
    // No number is produced that could be mistaken for an answer.
    expect(s.shortfallVsHarbour).toBe(undefined);
    expect(s.quarterlyPayment).toBe(undefined);
  });

  it('"what is my tax bracket?" comes back cited, dated and jurisdictional',()=>{
    const r=Tools.lookupTaxRule({ruleId:'fedBracketsMFJ',today:'2026-09-10'});
    expect(r.taxYear).toBe(2026);
    expect(r.jurisdiction).toBe('US-Federal');
    expect(r.source.url).toMatch(/irs\.gov/);
    expect(r.caveat).toMatch(/year and jurisdiction/);
  });
});

describe('Missing data never becomes a clean result',()=>{
  it('an empty context reports nothing checked rather than nothing wrong',()=>{
    const out=Monitors.detect({today:'2026-09-10'});
    expect(out.alerts).toEqual([]);
    const input=Monitors.briefingInput(out,Monitors.prioritize(out.alerts,{},{}));
    expect(input.complete).toBe(false);
    expect(input.notChecked.length).toBeGreaterThan(0);
  });

  it('a partial account sync is never differenced against the plan',()=>{
    const ctx={P,R:M.run(P).R,today:'2026-09-10',
      accounts:{netWorth:50,complete:false}};   // wildly off, and incomplete
    const out=Monitors.divergence(ctx);
    expect(out.alerts.filter(a=>a.key.includes('netWorth'))).toEqual([]);
    expect(out.skipped.length).toBeGreaterThan(0);
  });

  it('every skip names exactly what would unblock it',()=>{
    const out=Monitors.detect({P,R:M.run(P).R,today:'2026-09-10',liquidity:Liq});
    for(const s of out.skipped){
      expect(s.missing,JSON.stringify(s)).toBeTruthy();
      expect(String(s.missing).length,JSON.stringify(s)).toBeGreaterThan(3);
    }
  });

  it('an unknown parameter fails loudly rather than being dropped',()=>{
    const r=Tools.compute({P,overrides:{mortgageRateAssumption:6.5}});
    expect(r.error).toMatch(/mortgageRateAssumption/);
    expect(r.metrics).toBe(undefined);
  });

  it('an unresolvable decision trigger is reported, not treated as unmet',()=>{
    const out=Monitors.decisionReview({P,R:M.run(P).R,today:'2026-09-10',
      decisions:[{id:'d',title:'T',rationale:'R',status:'active',
        reconsiderWhen:[{id:'c',metric:'marketSentiment',op:'gt',value:1,
          description:'sentiment turns'}]}]});
    expect(out.alerts).toEqual([]);
    expect(out.skipped[0].note).toMatch(/should be revisited/);
  });
});

describe('Calculation checks against the engine itself',()=>{
  const R=M.run(P).R;

  it('every advertised metric reads the value the engine reports',()=>{
    const r=Tools.compute({P,metrics:Object.keys(Tools.METRICS)});
    const truth=M.run(P);
    expect(r.metrics.finalNetWorth.value).toBe(truth.R[truth.R.length-1].nw);
    expect(r.metrics.totalTax.value).toBe(truth.R.reduce((s,x)=>s+x.tax,0));
    expect(r.metrics.totalTuition.value).toBe(truth.tT);
    expect(r.metrics.negativeFlowYears.value).toBe(truth.R.filter(x=>x.flow<0).length);
    expect(r.metrics.monthlyMortgage.value).toBe(truth.mm);
    expect(r.unknownMetrics).toEqual([]);
  });

  it('the accounting identities hold in every projected year',()=>{
    for(const row of R){
      // Cash available plus the after-tax grant is total after-tax compensation.
      expect(row.inc+row.sNew,`${row.yr} comp split`).toBe(row.netTC);
      // Net flow is total after-tax pay less total spending.
      expect(row.flow,`${row.yr} net flow`).toBe(Math.round(row.netTC-row.totE));
      // The income gap is exactly the negative half of net flow.
      expect(row.incGap,`${row.yr} incGap`).toBe(Math.max(0,-row.flow));
      // Sold plus retained adds back to the after-tax grant.
      expect(row.sSold+row.sRet,`${row.yr} vest split`).toBe(row.sNew);
      // Gross grant less withholding is the after-tax grant.
      expect(Math.abs(row.sNew+row.sVestTax-row.sGross),`${row.yr} withholding`).toBeLessThanOrEqual(1);
      // Net worth is its three components.
      expect(Math.abs(row.nw-(row.liq+row.sEnd+row.eq)),`${row.yr} net worth`).toBeLessThanOrEqual(2);
    }
  });

  it('the tax engine still agrees with the cited rule table',()=>{
    const v=TaxRules.validate(M,{taxInflation:P.taxInflation,
      indexStateBrackets:P.indexStateBrackets??false,
      qbiPhaseBase:403500,qbiBandWidth:150000,modelsNIIT:false,modelsAMT:false,
      capGainsTaxRate:P.capGainsTaxRate});
    expect(v.findings.filter(f=>f.severity===TaxRules.SEV.ERROR)).toEqual([]);
  });

  it('a proposal\'s impact equals the difference between two real runs',()=>{
    const prop=Tools.proposeChanges({P,overrides:{homePrice:P.homePrice-500000},
      rationale:'Test.',metrics:['finalNetWorth']});
    const before=M.run(P);
    const after=M.run({...P,homePrice:P.homePrice-500000});
    expect(prop.impact.finalNetWorth.delta).toBe(
      after.R[after.R.length-1].nw-before.R[before.R.length-1].nw);
  });

  it('the home-funding check agrees with the sale-window calendar it cites',()=>{
    const p={...P,homePurchaseYear:2030,homePurchaseQuarter:3,stripeTenderQuarters:[4],
      startingLiquid:100000,startingStripeEquity:3000000,liquidReserveFloor:100000};
    const rows=M.run(p).R;
    const a=Monitors.homeFunding({P:p,R:rows,liquidity:Liq,today:'2026-09-10'}).alerts[0];
    if(a&&a.key.includes('shortfall')){
      const prev=rows.find(r=>r.yr===2029),row=rows.find(r=>r.yr===2030);
      const check=Liq.fundingCheck({year:2030,quarter:3,need:row.dpOut,
        heldValue:prev.sEnd,vestPerQuarter:row.sNew/4,
        otherCash:Math.max(0,prev.liq-100000)},p);
      expect(check.fundable).toBe(false);
    }
  });
});

describe('Nothing claims more certainty than it has',()=>{
  it('projections are never labelled forecasts',()=>{
    expect(Tools.compute({P}).note).toMatch(/not forecasts/);
  });

  it('an eligibility question is never priced as a saving',()=>{
    const opps=TaxPlan.screenOpportunities({P,R:M.run(P).R,marginalRate:0.45});
    for(const o of opps){
      if(o.confidence===TaxPlan.CONFIDENCE.REQUIRES_CONFIRMATION){
        expect(o.eligibility.length,o.id).toBeGreaterThan(0);
        // QSBS in particular must carry no number at all.
        if(o.id==='qsbs')expect(o.estimatedSaving).toBe(null);
      }
    }
  });

  it('the safe harbour is never described as reducing the bill',()=>{
    const s=TaxPlan.withholdingStatus({projectedLiability:420000,withheldToDate:340000,
      priorYearLiability:300000,priorYearAGI:1e6,asOf:'2026-08-15'});
    expect(s.interpretation).toMatch(/still projected to be due|set it aside/);
    expect(s.safeHarbour.note).toMatch(/does NOT reduce the tax/);
  });

  it('the rule table declares its own age rather than implying it is live',()=>{
    expect(TaxRules.staleness('2028-06-01').coversCurrentYear).toBe(false);
    expect(Tools.lookupTaxRule({ruleId:'fedBracketsMFJ',today:'2028-06-01'}).caveat)
      .toMatch(/^WARNING/);
  });
});
