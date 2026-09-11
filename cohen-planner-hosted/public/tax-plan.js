'use strict';
// ═══ TAX PLANNING — LIABILITY vs WHAT HAS ACTUALLY BEEN PAID ═══
// Pure, shared by browser and Node. Builds on tax-rules.js for every quoted figure.
//
// The projection already computes what is OWED. This computes what has been PAID, which is
// a different question and the one that produces a surprise in April. A household with a
// large RSU grant is the classic case: the employer withholds on the vest at a flat
// supplemental rate, the household's marginal rate is higher, and nobody notices the gap
// until the return is filed — by which point the § 6654 interest has already accrued.
//
// Two disciplines run through this file.
//
// ASK, DO NOT ASSUME. Every calculation states the inputs it needs. Where one is missing it
// returns a `needs` entry describing the document that would supply it — a vest paystub, a
// prior-year return, a basis statement — rather than substituting a plausible number. A
// withholding figure invented to make a calculation complete is worse than no calculation.
//
// AN ESTIMATE IS NOT AN ELIGIBILITY OPINION. Screened opportunities carry a confidence:
// ESTIMATE means the arithmetic is ours and the numbers are checkable; REQUIRES_CONFIRMATION
// means the dollar figure may be right while the entitlement turns on facts a professional
// has to verify. The two are never merged, and a REQUIRES_CONFIRMATION item never presents
// its saving as banked.

(function(root,rules){

  const CONFIDENCE={
    ESTIMATE:'estimate',                       // our arithmetic, our stated assumptions
    REQUIRES_CONFIRMATION:'requiresConfirmation', // eligibility needs a professional
  };
  const DOC={
    VEST_PAYSTUB:'vestPaystub',
    PAYSTUB_YTD:'paystubYearToDate',
    PRIOR_RETURN:'priorYearReturn',
    BASIS_STATEMENT:'basisStatement',
    ESTIMATED_PAYMENTS:'estimatedPaymentRecord',
  };

  const usd=v=>(v<0?'−':'')+'$'+Math.round(Math.abs(v)).toLocaleString('en-US');
  // Number(null) and Number('') are both 0, which would read an UNSET field as a genuine
  // zero — exactly the substitution this file exists to avoid.
  const num=v=>{if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null};

  // A missing input, named alongside the document that would supply it. This is the shape
  // the UI turns into a request and the advisor turns into a question.
  const need=(field,doc,why)=>({field,document:doc,why});

  // ── Safe harbour ─────────────────────────────────────────────────────────
  // § 6654 does not require paying the right amount during the year. It requires paying the
  // LESSER of 90% of this year's tax or a percentage of last year's — 110% once prior-year
  // AGI passes $150,000, which this household is far beyond. Both figures are statutory and
  // neither is indexed.
  //
  // The distinction matters in a year with a large vest: the safe harbour can be a fraction
  // of the real bill, so meeting it avoids interest while still leaving a very large amount
  // due in April. Reporting one number without the other invites exactly the wrong reaction.
  const SAFE_HARBOUR={
    currentYearShare:0.90,
    priorYearShare:1.00,
    priorYearShareHighIncome:1.10,
    highIncomeAGI:150000,
    citation:'IRC § 6654(d)(1)(B)-(C)',
  };

  function safeHarbour({projectedLiability,priorYearLiability,priorYearAGI}){
    const needs=[];
    const cur=num(projectedLiability);
    if(cur==null)needs.push(need('projectedLiability',null,
      'The projection has to be run before this year\'s liability is known.'));
    const prior=num(priorYearLiability);
    if(prior==null)needs.push(need('priorYearLiability',DOC.PRIOR_RETURN,
      'The prior-year safe harbour is usually the cheaper of the two, and it can only be read off last year\'s return (Form 1040, total tax).'));
    const priorAGI=num(priorYearAGI);
    if(priorAGI==null)needs.push(need('priorYearAGI',DOC.PRIOR_RETURN,
      'Whether the prior-year safe harbour is 100% or 110% turns on last year\'s AGI. It is on the same page as the total tax, so both come off one document.'));

    const currentRoute=cur!=null?cur*SAFE_HARBOUR.currentYearShare:null;
    // Where AGI is unknown but the household is plainly high-income, the CONSERVATIVE
    // reading is the one that keeps you out of trouble: assume 110% and say so.
    const assumedHighIncome=priorAGI==null?true:priorAGI>SAFE_HARBOUR.highIncomeAGI;
    const priorShare=assumedHighIncome?SAFE_HARBOUR.priorYearShareHighIncome:SAFE_HARBOUR.priorYearShare;
    const priorRoute=prior!=null?prior*priorShare:null;

    const routes=[currentRoute,priorRoute].filter(v=>v!=null);
    const required=routes.length?Math.min(...routes):null;
    return{
      required,
      currentYearRoute:currentRoute,
      priorYearRoute:priorRoute,
      priorYearShareUsed:priorShare,
      priorAGIAssumed:priorAGI==null,
      cheaperRoute:required==null?null:(required===priorRoute?'prior year':'current year'),
      citation:SAFE_HARBOUR.citation,
      needs,
      note:required==null
        ?'The safe harbour cannot be computed yet.'
        :`Paying ${usd(required)} across the four instalments avoids the § 6654 underpayment charge. It does NOT reduce the tax — whatever is still owed is due with the return.`,
    };
  }

  // ── Liability against what has been paid ─────────────────────────────────
  // Withholding is treated as paid EVENLY across the year regardless of when it happened
  // (§ 6654(g)). That is the single most useful fact here: a shortfall discovered in
  // November can still be cured through payroll, where an estimated payment in November
  // only covers the November instalment.
  function withholdingStatus(input){
    const i=input||{};
    // Payment timing and jurisdiction-specific facts are not collected by this workflow.
    // An annual reserve can be estimated; an installment or penalty conclusion cannot.
    if(i.jurisdiction!=='federal'&&num(i.withheldToDate)!=null){
      const projected=num(i.projectedLiability),withheld=num(i.withheldToDate),paid=num(i.estimatedPaid)??0;
      return{status:'reserve-only',projectedLiability:projected,needs:[],
        shortfallVsLiability:projected!=null&&withheld!=null?Math.max(0,projected-withheld-paid):null,
        quarterlyPayment:null,safeHarbour:null,remaining:[],instalments:[],
        interpretation:'Annual combined-tax reserve estimate only. Federal, state and city payments must be separated before payment guidance is available. Payment timing and penalties have not been evaluated.',
        remedy:null};
    }
    const needs=[];
    const projected=num(i.projectedLiability);
    if(projected==null)needs.push(need('projectedLiability',null,'Run the projection first.'));
    const withheld=num(i.withheldToDate);
    if(withheld==null)needs.push(need('withheldToDate',DOC.PAYSTUB_YTD,
      'Federal, state and city tax withheld year to date — the year-to-date column of the most recent paystub for each earner.'));
    const estimatedPaid=num(i.estimatedPaid)??0;

    const asOf=i.asOf?new Date(i.asOf):new Date();
    // In February two tax years are live: last year's return is not yet filed and this
    // year's first instalment is not yet due. Which one is being planned has to be said,
    // not inferred from today's date.
    const y=num(i.taxYear)??asOf.getFullYear();
    // Instalment dates are statutory. Which ones have passed drives everything below.
    const instalments=[
      {label:'Q1',due:`${y}-04-15`},{label:'Q2',due:`${y}-06-15`},
      {label:'Q3',due:`${y}-09-15`},{label:'Q4',due:`${y+1}-01-15`},
    ].map(q=>({...q,passed:Date.parse(q.due)<asOf.getTime()}));
    const remaining=instalments.filter(q=>!q.passed);

    const harbour=safeHarbour(i);
    for(const n of harbour.needs)if(!needs.some(x=>x.field===n.field))needs.push(n);

    if(projected==null||withheld==null){
      return{status:'incomplete',needs,instalments,remaining,safeHarbour:harbour,
        note:'Payments cannot be compared to liability until the missing figures above are supplied.'};
    }

    const paid=withheld+estimatedPaid;
    const shortfallVsLiability=Math.max(0,projected-paid);
    const target=harbour.required??projected;
    const shortfallVsHarbour=Math.max(0,target-paid);

    // Projected withholding for the whole year, if payroll continues at the current pace.
    // Only meaningful once some of the year has elapsed.
    const fractionElapsed=(asOf-new Date(y,0,1))/(new Date(y+1,0,1)-new Date(y,0,1));
    const projectedWithholding=fractionElapsed>0.08?withheld/fractionElapsed:null;
    const projectedYearEndGap=projectedWithholding!=null
      ?Math.max(0,projected-(projectedWithholding+estimatedPaid)):null;

    // Spread the remaining safe-harbour shortfall over the instalments still to come. With
    // none left, it is not an instalment any more — it is due with the return.
    const quarterlyPayment=remaining.length&&shortfallVsHarbour>0
      ?shortfallVsHarbour/remaining.length:0;

    return{
      status:'ok',needs,
      projectedLiability:projected,withheldToDate:withheld,estimatedPaid,paidToDate:paid,
      safeHarbour:harbour,
      shortfallVsLiability,shortfallVsHarbour,
      quarterlyPayment:null,
      instalments,remaining,
      nextInstalment:remaining[0]||null,
      fractionElapsed:+fractionElapsed.toFixed(4),
      projectedWithholding,projectedYearEndGap,
      // Two numbers that are routinely confused, kept apart on purpose.
      interpretation:`Annual federal comparison only: ${usd(shortfallVsLiability)} of projected liability remains after reported payments. Payment dates and installment rules have not been evaluated; no penalty conclusion is available.`,
      remedy:null,

    };
  }

  // ── Opportunity screening ────────────────────────────────────────────────
  // Each screen returns nothing at all unless the conditions for it are actually present.
  // Where a saving depends on an input we do not have, the item is still surfaced — with
  // the saving left null and the missing document named — because "you may be leaving money
  // here, and here is what I need to tell you how much" is useful, and a made-up figure is
  // not.
  const opportunity=(id,title,confidence,fields)=>({id,title,confidence,
    estimatedSaving:null,assumptions:[],eligibility:[],needs:[],...fields});

  function screenOpportunities(ctx){
    const c=ctx||{};
    const P=c.P||{};
    const row=c.R&&c.R.length?c.R[0]:null;
    const out=[];
    const marginal=num(c.marginalRate)??(row?num(row.sVestRate):null);
    const R=rules&&rules.RULES;

    // 1. Unused elective deferral room. Pure arithmetic against a cited limit.
    const limit=num(P.elective401kLimit)??(R?num(R.elective401kDeferral.value):null);
    const deferring=num(P.pretax401k);
    if(limit!=null&&deferring!=null&&deferring<limit){
      const room=limit-deferring;
      out.push(opportunity('deferralRoom',
        `${usd(room)} of 401(k) deferral room is unused`,CONFIDENCE.ESTIMATE,{
        estimatedSaving:marginal!=null?room*marginal:null,
        basis:`${usd(room)} deferred at a ${marginal!=null?(marginal*100).toFixed(1)+'%':'n/a'} marginal rate`,
        assumptions:[
          'Tax deferred, not forgiven — it is paid on withdrawal, presumably at a lower rate.',
          'Assumes the plan permits a mid-year deferral change and enough pay periods remain.',
        ],
        needs:marginal==null?[need('marginalRate',null,'Run the projection to derive the marginal rate.')]:[],
        source:R?rules.cite('elective401kDeferral'):null,
        action:'Raise the payroll deferral for the remaining pay periods.',
      }));
    }

    // 2. Under-withholding on the vest. The specific trap this household is exposed to.
    if(row&&num(row.sGross)>0){
      const actualRate=num(P.stripeVestWithholdingRate);
      const modelRate=num(row.sVestRate);
      if(actualRate!=null&&modelRate!=null&&modelRate-actualRate>0.02){
        const gap=row.sGross*(modelRate-actualRate);
        out.push(opportunity('vestUnderWithholding',
          `Vest withholding is ${((modelRate-actualRate)*100).toFixed(1)} points below your marginal rate`,
          CONFIDENCE.ESTIMATE,{
          estimatedSaving:null,          // this is a liability, not a saving
          liability:gap,
          basis:`${usd(row.sGross)} of grant withheld at ${(actualRate*100).toFixed(1)}% against a ${(modelRate*100).toFixed(1)}% marginal rate`,
          assumptions:['Marginal rate derived from the projection for this year.'],
          source:'Employer supplemental withholding is a flat statutory rate, not your marginal rate.',
          action:`Expect roughly ${usd(gap)} of additional tax on this grant. Cover it through payroll withholding rather than an estimated payment — withholding is treated as paid across the whole year.`,
        }));
      } else if(actualRate==null){
        out.push(opportunity('vestWithholdingUnknown',
          'Vest withholding rate has not been confirmed',CONFIDENCE.ESTIMATE,{
          basis:`The model is using a derived marginal rate of ${modelRate!=null?(modelRate*100).toFixed(1)+'%':'n/a'}.`,
          needs:[need('stripeVestWithholdingRate',DOC.VEST_PAYSTUB,
            'The federal, state, city and Medicare amounts withheld on a vest, and the gross value of that vest. Employers withhold at a flat supplemental rate that is usually well below a marginal rate at this income, and the difference lands in April.')],
          action:'Send one vest paystub. It takes the largest single unknown out of the tax picture.',
        }));
      }
    }

    // 3. Charitable bunching. Only worth raising where the household actually gives and the
    // 0.5% AGI floor is biting.
    const charity=num(P.baseCharity);
    const agi=row?num(row.gross):null;
    if(charity!=null&&charity>0&&agi!=null){
      const floor=0.005*agi;
      if(charity<floor*2){
        const lost=Math.min(charity,floor);
        out.push(opportunity('charitableBunching',
          'Charitable giving is largely absorbed by the 0.5% AGI floor',CONFIDENCE.REQUIRES_CONFIRMATION,{
          estimatedSaving:marginal!=null?lost*marginal:null,
          basis:`${usd(charity)} given against a ${usd(floor)} floor, so roughly ${usd(lost)} is non-deductible each year it is given evenly.`,
          assumptions:[
            'Assumes giving continues at the current annual rate.',
            'Assumes the household itemises, which the projection reports year by year.',
          ],
          eligibility:[
            'Bunching several years of giving into one — or funding a donor-advised fund — clears the floor once instead of never. Whether that suits your giving is not a tax question.',
            'A contribution to a donor-advised fund is deductible when made, not when granted out. Confirm the treatment with your accountant before relying on the timing.',
          ],
          action:'Raise it with your accountant before year end; the decision has to be made before the cheque is written.',
        }));
      }
    }

    // 4. Tax-loss harvesting. We cannot know whether losses exist without lot-level basis.
    if(row&&num(row.liq)>0){
      out.push(opportunity('lossHarvesting',
        'Unrealised losses in the taxable portfolio have not been checked',CONFIDENCE.ESTIMATE,{
        basis:`The portfolio holds ${usd(row.liq)}, but the planner models it as one balance with no lot detail.`,
        needs:[need('taxableLots',DOC.BASIS_STATEMENT,
          'A realised/unrealised gain-loss report from the brokerage. Without cost basis per lot there is no way to say whether any position is at a loss.')],
        assumptions:['A harvested loss offsets capital gain first, then up to $3,000 of ordinary income, with the rest carried forward.'],
        eligibility:['The wash-sale rule disallows the loss if a substantially identical security is bought within 30 days either side. Repurchase timing has to be checked against every account, including retirement accounts.'],
        action:'Upload a gain-loss statement and this becomes a real number rather than a possibility.',
      }));
    }

    // 5. QSBS. Enormous if it applies and almost never applies to RSUs — exactly the shape
    // of question that must never be answered with an estimate.
    if(row&&num(row.sEnd)>0){
      out.push(opportunity('qsbs',
        'Whether any Stripe shares could qualify under § 1202 is unresolved',CONFIDENCE.REQUIRES_CONFIRMATION,{
        estimatedSaving:null,
        basis:`The position is ${usd(row.sEnd)}. § 1202 can exclude a large share of the gain on qualified small business stock.`,
        eligibility:[
          'Shares generally must be acquired at ORIGINAL ISSUE from the company. Stock received on the settlement of an RSU is usually treated as acquired at settlement, which can qualify, but the company\'s gross assets must have been under the statutory ceiling at that time — for a company at Stripe\'s scale that is unlikely for recent grants and may differ for early ones.',
          'A five-year holding period applies, running from acquisition.',
          'New York State does not conform to the federal exclusion, so state tax is unaffected regardless.',
        ],
        assumptions:[],
        needs:[need('shareAcquisitionHistory',DOC.BASIS_STATEMENT,
          'Grant and settlement dates for each tranche, and any § 1202 statement the company has provided.')],
        action:'This is a question for a tax adviser with the company\'s own § 1202 position in hand. Do not plan around it until it is confirmed in writing — the planner deliberately assigns it no value.',
        source:'IRC § 1202',
      }));
    }

    // 6. Holding period on shares earmarked for sale. Arithmetic, but the eligibility (which
    // lots, acquired when) needs the ledger.
    if(row&&num(row.sHold)>0){
      out.push(opportunity('holdingPeriod',
        'Held shares are being sold — check the holding period before the tender',CONFIDENCE.REQUIRES_CONFIRMATION,{
        basis:`The plan sells ${usd(row.sHold)} of previously vested shares in ${row.yr}.`,
        eligibility:['A sale inside twelve months of vesting is taxed at ordinary rates rather than long-term capital gains. On a large position the difference is the single biggest controllable number in the transaction.'],
        needs:[need('lotAcquisitionDates',DOC.BASIS_STATEMENT,
          'Vest dates for the specific lots you intend to tender.')],
        action:'Check vest dates against the tender date before committing a sale size.',
      }));
    }

    // Deterministic order, so the same picture produces the same list.
    return out.sort((a,b)=>{
      const av=a.estimatedSaving??a.liability??0,bv=b.estimatedSaving??b.liability??0;
      if(av!==bv)return bv-av;
      return a.id<b.id?-1:1;
    });
  }

  // ── Document extraction, held for review ─────────────────────────────────
  // Nothing extracted from a document is used until a person has confirmed it. This wraps a
  // set of extracted fields in a review envelope: the value, where in the document it came
  // from, and an explicit accepted flag that starts false. `applyReview` refuses to hand
  // back anything unconfirmed, so an extraction error cannot reach the model by default.
  function stageExtraction(documentType,fields,meta){
    return{
      documentType,
      stagedAt:(meta&&meta.at)||new Date().toISOString(),
      filename:(meta&&meta.filename)||null,
      status:'awaitingReview',
      fields:(fields||[]).map(f=>({
        field:f.field,label:f.label||f.field,value:f.value,
        // Where in the document this was read from, so it can be checked without re-reading
        // the whole thing.
        locator:f.locator||null,
        confidence:f.confidence??null,
        accepted:false,corrected:null,
      })),
      note:'Nothing here is applied to the plan until each value is reviewed and accepted.',
    };
  }

  function applyReview(staged,decisions){
    const d=decisions||{};
    const accepted={},rejected=[],pending=[];
    for(const f of staged.fields){
      const choice=d[f.field];
      if(!choice||choice.accepted!==true){
        if(choice&&choice.accepted===false)rejected.push(f.field);else pending.push(f.field);
        continue;
      }
      accepted[f.field]=choice.corrected!=null?choice.corrected:f.value;
    }
    return{
      accepted,rejected,pending,
      // Only complete once every field has been decided either way. Partial acceptance is
      // fine; silently treating undecided fields as accepted is not.
      complete:pending.length===0,
      status:pending.length?'awaitingReview':'reviewed',
    };
  }

  // What to ask for, and only what is actually missing. Grouped by document so a person is
  // asked for one paystub rather than four separate numbers off the same page.
  function documentRequests(needs){
    const byDoc=new Map();
    for(const n of needs||[]){
      if(!n.document)continue;
      if(!byDoc.has(n.document))byDoc.set(n.document,{document:n.document,fields:[],reasons:[]});
      const g=byDoc.get(n.document);
      g.fields.push(n.field);
      if(!g.reasons.includes(n.why))g.reasons.push(n.why);
    }
    const LABEL={
      [DOC.VEST_PAYSTUB]:'A paystub covering a vest',
      [DOC.PAYSTUB_YTD]:'Your most recent paystub (year-to-date column)',
      [DOC.PRIOR_RETURN]:'Last year\'s filed return (Form 1040)',
      [DOC.BASIS_STATEMENT]:'A cost-basis or gain-loss statement from the brokerage',
      [DOC.ESTIMATED_PAYMENTS]:'A record of estimated payments made this year',
    };
    return[...byDoc.values()].map(g=>({...g,label:LABEL[g.document]||g.document}));
  }

  const api={CONFIDENCE,DOC,SAFE_HARBOUR,safeHarbour,withholdingStatus,
    screenOpportunities,stageExtraction,applyReview,documentRequests,need};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerTaxPlan=api;
})(typeof window!=='undefined'?window:this,
   typeof module!=='undefined'&&module.exports?require('./tax-rules.js')
     :(typeof window!=='undefined'?window.PlannerTaxRules:null));
