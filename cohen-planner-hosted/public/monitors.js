'use strict';
// ═══ DETERMINISTIC MONITORING ═══
// Pure, shared by browser and Node. No DOM, no I/O, no model calls of its own — everything
// it reports is read out of a context the caller assembles.
//
// The rule this file exists to enforce: AN ALERT IS A MEASUREMENT, NOT AN OPINION. Every
// condition below is a comparison between two numbers that already exist somewhere in the
// plan or the account data. Language models are good at explaining a detected condition and
// catastrophic at deciding whether one exists — a plausible-sounding warning about a
// breach that never happened is worse than silence, because it spends the reader's trust
// and their attention at the same time. So detection is arithmetic here, and the advisor's
// only job is to narrate what this file found.
//
// The second rule: A MONITOR THAT CANNOT RUN MUST SAY SO. Every check that lacks the data
// it needs returns a `skipped` entry naming the missing input. Otherwise "no alerts" is
// ambiguous between "nothing is wrong" and "nothing was checked", and those are opposite
// messages to send someone about their money.

(function(root){

  const SEVERITY={CRITICAL:'critical',WARNING:'warning',INFO:'info'};
  const RANK={critical:0,warning:1,info:2};
  const KIND={
    RESERVE_FLOOR:'reserveFloor',
    HOME_FUNDING:'homeFunding',
    CONCENTRATION:'concentration',
    DIVERGENCE:'divergence',
    DEADLINE:'deadline',
    DECISION_REVIEW:'decisionReview',
  };
  // Why a check could not run. These are not failures — they are the honest answer to
  // "did you look?", and each names the one input that would let the check run.
  const SKIP={NO_DATA:'noData',NOT_CONFIGURED:'notConfigured',OUT_OF_HORIZON:'outOfHorizon'};

  const usd=v=>(v<0?'−':'')+'$'+Math.round(Math.abs(v)).toLocaleString('en-US');
  const pct=v=>(v*100).toFixed(1)+'%';
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
  const isoDay=d=>new Date(d).toISOString().slice(0,10);

  // ── Alert identity ───────────────────────────────────────────────────────
  // The dedup key must name the CONDITION, not the moment it was noticed. A reserve floor
  // breached in 2031 is the same alert whether it is detected today or next Tuesday, so
  // dismissing it dismisses it for good rather than for one refresh. Anything that varies
  // run to run — a balance, a timestamp, a rounded dollar figure — stays out of the key.
  const keyOf=(kind,...parts)=>[kind,...parts.filter(p=>p!=null&&p!=='')].join(':');

  function alert(kind,severity,key,title,evidence,significance,action,extra){
    return{key,kind,severity,title,
      // Evidence is a list of {label,value,source} so a reader can check every number
      // against where it came from rather than taking the headline on faith.
      evidence:evidence||[],
      significance,action,...(extra||{})};
  }
  const ev=(label,value,source)=>({label,value,source});
  const skip=(kind,reason,missing,note)=>({kind,reason,missing,note});

  // ── 1. Reserve-floor breaches ────────────────────────────────────────────
  // The plan carries an explicit floor under the diversified pool. A projection that dips
  // below it is not a rounding artefact; it is the plan saying it intends to spend the
  // reserve. Reported once for the worst year rather than once per year, because thirty
  // near-identical alerts are the same information with the signal removed.
  function reserveFloor(ctx){
    const{R,P}=ctx;
    const alerts=[],skipped=[];
    if(!R||!R.length){skipped.push(skip(KIND.RESERVE_FLOOR,SKIP.NO_DATA,'projection results',
      'No projection has been run, so no year can be checked against the floor.'));return{alerts,skipped}}
    const floor=num(P&&(P.liquidReserveFloor??P.stripeLiquidFloor));
    if(floor==null){skipped.push(skip(KIND.RESERVE_FLOOR,SKIP.NOT_CONFIGURED,'liquidReserveFloor',
      'No reserve floor is set, so there is nothing to breach.'));return{alerts,skipped}}

    const breaches=R.filter(r=>r.liq<floor);
    if(!breaches.length)return{alerts,skipped};
    const worst=breaches.reduce((a,b)=>b.liq<a.liq?b:a);
    const negative=breaches.filter(r=>r.liq<0);
    // A pool that merely dips under the floor is a plan working as designed. A pool that
    // goes NEGATIVE is a plan with no funding source at all, and it is a different alert.
    const insolvent=negative.length>0;
    const subject=insolvent?negative.reduce((a,b)=>b.liq<a.liq?b:a):worst;

    alerts.push(alert(KIND.RESERVE_FLOOR,insolvent?SEVERITY.CRITICAL:SEVERITY.WARNING,
      keyOf(KIND.RESERVE_FLOOR,insolvent?'negative':'below',subject.yr),
      insolvent
        ?`Projected liquid assets go negative in ${subject.yr}`
        :`Reserve floor is breached in ${breaches.length} year${breaches.length===1?'':'s'}, worst in ${worst.yr}`,
      [ev('Reserve floor',usd(floor),'plan setting liquidReserveFloor'),
       ev(`Projected liquid, ${subject.yr}`,usd(subject.liq),'projection'),
       ev('Shortfall against the floor',usd(floor-subject.liq),'computed'),
       ev('Years below the floor',String(breaches.length),'projection'),
       ev('First year below',String(breaches[0].yr),'projection')],
      insolvent
        ?`The plan runs out of sellable assets. Every funding source — the portfolio, this year's vest and previously held Stripe — is exhausted, and ${usd(-subject.liq)} of spending has nothing behind it.`
        :`The floor exists so a bad year does not force a sale at a bad price. Spending into it removes that protection for ${breaches.length} year${breaches.length===1?'':'s'}.`,
      insolvent
        ?`Something has to give before ${subject.yr}: less spending, a smaller or later home, or more income. Model each in the What-If Lab and compare.`
        :`Either accept a lower floor deliberately, or find ${usd(floor-worst.liq)} between now and ${worst.yr}.`,
      {year:subject.yr}));
    return{alerts,skipped};
  }

  // ── 2. Home funding that depends on selling private stock ────────────────
  // The annual model can report a purchase fully funded while the cash is unreachable in
  // the quarter the cheque clears: vested Stripe is not a bank balance, and a tender is a
  // date, not a button. This check re-runs the purchase against the actual sale calendar.
  function homeFunding(ctx){
    const{R,P,liquidity}=ctx;
    const alerts=[],skipped=[];
    if(!R||!R.length||!P){skipped.push(skip(KIND.HOME_FUNDING,SKIP.NO_DATA,'projection results',null));return{alerts,skipped}}
    if(!liquidity){skipped.push(skip(KIND.HOME_FUNDING,SKIP.NO_DATA,'liquidity module',
      'The sale-window calendar is unavailable, so funding timing cannot be checked.'));return{alerts,skipped}}
    const buyYear=num(P.homePurchaseYear);
    if(buyYear==null||!R.some(r=>r.yr===buyYear)){
      skipped.push(skip(KIND.HOME_FUNDING,SKIP.OUT_OF_HORIZON,'homePurchaseYear',
        'The purchase year is outside the projection, so its funding cannot be checked.'));
      return{alerts,skipped};
    }
    const row=R.find(r=>r.yr===buyYear);
    const prev=R.find(r=>r.yr===buyYear-1);
    const quarter=liquidity.purchaseQuarter(P);
    const need=num(row.dpOut)||0;
    if(need<=0)return{alerts,skipped};

    // Cash on hand that is NOT Stripe: the portfolio, down to its floor.
    const floor=num(P.liquidReserveFloor??P.stripeLiquidFloor)??0;
    const pool=prev?num(prev.liq):num(P.startingLiquid);
    const otherCash=Math.max(0,(pool||0)-floor);
    const held=prev?num(prev.sEnd):num(P.startingStripeEquity)||0;
    const vestPerQuarter=(num(row.sNew)||0)/4;

    const check=liquidity.fundingCheck({year:buyYear,quarter,need,heldValue:held,
      vestPerQuarter,otherCash},P);
    // How much of the purchase leans on stock rather than cash — the thing that makes the
    // date matter. Fully funded from the portfolio, the tender calendar is irrelevant.
    const stripeShare=need>0?Math.min(1,Math.max(0,(need-otherCash)/need)):0;

    if(!check.fundable){
      alerts.push(alert(KIND.HOME_FUNDING,SEVERITY.CRITICAL,
        keyOf(KIND.HOME_FUNDING,'shortfall',buyYear,quarter),
        `The ${buyYear} down payment is short by ${usd(check.shortfall)} at closing`,
        [ev('Cash needed at closing',usd(need),'projection dpOut'),
         ev(`Closing quarter`,`Q${quarter}`+(P.homePurchaseQuarter==null?' (assumed)':''),'plan setting homePurchaseQuarter'),
         ev('Portfolio available above the floor',usd(otherCash),'projection'),
         ev(`Raisable from Stripe by Q${quarter}`,usd(check.fromStripe),'tender and elective windows'),
         ev('Total available',usd(check.available),'computed'),
         ev('Shortfall',usd(check.shortfall),'computed')],
        `The annual projection shows this year funded, but the money is not reachable by the quarter the purchase closes. Stripe is private: it converts to cash only in a tender window or through the standing quarterly election.`,
        check.remedy||`Move the closing to a quarter with a tender window, reduce the purchase, or fund more of it from the portfolio.`,
        {year:buyYear,quarter}));
    } else if(stripeShare>=0.25){
      alerts.push(alert(KIND.HOME_FUNDING,SEVERITY.WARNING,
        keyOf(KIND.HOME_FUNDING,'stockDependent',buyYear),
        `${pct(stripeShare)} of the ${buyYear} down payment depends on selling Stripe`,
        [ev('Cash needed at closing',usd(need),'projection dpOut'),
         ev('Closing quarter',`Q${quarter}`+(P.homePurchaseQuarter==null?' (assumed)':''),'plan setting homePurchaseQuarter'),
         ev('From the portfolio',usd(Math.min(need,otherCash)),'projection'),
         ev('From Stripe',usd(Math.max(0,need-otherCash)),'computed'),
         ev(`Raisable from Stripe by Q${quarter}`,usd(check.fromStripe),'tender and elective windows'),
         ev('Headroom',usd(check.available-need),'computed')],
        `It clears today, but on a private mark and a tender calendar neither of which you control. A cancelled tender, a delayed close, or a lower mark all land on the same date.`,
        `Decide in advance what you would do if the tender before closing does not happen — a bridge, a later close, or a smaller purchase — and write it down as a decision so this alert stops resurfacing.`,
        {year:buyYear,quarter}));
    }
    return{alerts,skipped};
  }

  // ── 3. Concentration ─────────────────────────────────────────────────────
  // Threshold is the USER'S, not a default dressed up as advice. With none set, this
  // returns a request for the input rather than picking a number and alerting against it.
  function concentration(ctx){
    const{R,P,accounts}=ctx;
    const alerts=[],skipped=[];
    const threshold=num(P&&P.concentrationThreshold);
    if(threshold==null||threshold<=0||threshold>=1){
      skipped.push(skip(KIND.CONCENTRATION,SKIP.NOT_CONFIGURED,'concentrationThreshold',
        'No concentration limit has been set. Set the share of net worth you are willing to hold in Stripe and this will be checked on every refresh.'));
      return{alerts,skipped};
    }

    // Prefer what the accounts actually show over what the plan projects.
    let observed=null;
    if(accounts&&accounts.complete!==false&&num(accounts.netWorth)>0&&num(accounts.stripeVested)!=null)
      observed={share:num(accounts.stripeVested)/num(accounts.netWorth),
        value:num(accounts.stripeVested),base:num(accounts.netWorth),source:'live account balances'};

    const projected=R&&R.length?R[0]:null;
    const current=observed||(projected&&projected.nw>0
      ?{share:projected.sPct,value:projected.sEnd,base:projected.nw,source:'projection'}:null);
    if(!current){
      skipped.push(skip(KIND.CONCENTRATION,SKIP.NO_DATA,'net worth',
        'Neither live balances nor a projection are available, so concentration cannot be measured.'));
      return{alerts,skipped};
    }

    if(current.share>threshold){
      alerts.push(alert(KIND.CONCENTRATION,current.share>threshold*1.5?SEVERITY.CRITICAL:SEVERITY.WARNING,
        keyOf(KIND.CONCENTRATION,'over',Math.round(threshold*100)),
        `Stripe is ${pct(current.share)} of net worth, above your ${pct(threshold)} limit`,
        [ev('Stripe position',usd(current.value),current.source),
         ev('Net worth',usd(current.base),current.source),
         ev('Share',pct(current.share),'computed'),
         ev('Your limit',pct(threshold),'plan setting concentrationThreshold'),
         ev('Value above the limit',usd(current.value-threshold*current.base),'computed')],
        `A single private company holds ${pct(current.share)} of the household's wealth, and it is the same company that pays the salary. A bad outcome would arrive as a lost job and a lost balance sheet on the same day.`,
        `Selling ${usd(current.value-threshold*current.base)} at the next tender brings you back to your limit. Compare that against the tax it triggers before deciding.`,
        {share:current.share,threshold}));
    }

    // Rising toward the limit is worth knowing before it is crossed, but only if the
    // crossing is inside the horizon and is not already the alert above.
    if(R&&R.length&&current.share<=threshold){
      const crossing=R.find(r=>r.sPct>threshold);
      if(crossing)alerts.push(alert(KIND.CONCENTRATION,SEVERITY.INFO,
        keyOf(KIND.CONCENTRATION,'projectedCross',crossing.yr),
        `Stripe passes your ${pct(threshold)} limit in ${crossing.yr}`,
        [ev('Today',pct(current.share),current.source),
         ev(`Projected, ${crossing.yr}`,pct(crossing.sPct),'projection'),
         ev('Your limit',pct(threshold),'plan setting concentrationThreshold'),
         ev('Retention policy',String((P&&P.stripePolicy)||'deficit'),'plan setting stripePolicy')],
        `Under the current retention policy the position grows faster than the rest of the balance sheet, so the limit is crossed by holding still rather than by any decision.`,
        `If the limit is real, the retention policy has to change before ${crossing.yr}. Compare 'Sell a fixed %' against the current policy in the What-If Lab.`,
        {year:crossing.yr}));
    }
    return{alerts,skipped};
  }

  // ── 4. Actual versus plan ────────────────────────────────────────────────
  // Only runs where the underlying data exists, and says which comparisons it could not
  // make. A divergence report built on a partial account sync is worse than none: it
  // reports as a change what is only a gap in coverage.
  function divergence(ctx){
    const{R,P,accounts,spending}=ctx;
    const alerts=[],skipped=[];
    const materialPct=num(P&&P.divergenceThresholdPct)??0.15;
    const materialAbs=num(P&&P.divergenceThresholdAbs)??50000;

    // Balance sheet.
    if(!accounts||accounts.complete===false||num(accounts.netWorth)==null){
      skipped.push(skip(KIND.DIVERGENCE,SKIP.NO_DATA,'complete account balances',
        accounts&&accounts.complete===false
          ?'Some account balances are missing, so the totals are short by an unknown amount and cannot be differenced against the plan.'
          :'No account snapshot is available.'));
    } else {
      skipped.push(skip(KIND.DIVERGENCE,SKIP.NO_DATA,'matching valuation date and asset scope',
        'Current account wealth cannot be compared directly with projected year-end wealth. Review opening assumptions in the account reconciliation.'));
    }

    // Spending. Needs enough COMPLETE months to average; a partial month is a fraction of a
    // data point, not a data point.
    if(!spending||!spending.completeMonths||spending.completeMonths.length<3){
      skipped.push(skip(KIND.DIVERGENCE,SKIP.NO_DATA,'at least 3 complete months of transactions',
        'Spending cannot be compared to plan without a few full months to average.'));
    } else if(R&&R.length&&num(spending.monthlyExpense)!=null){
      const plannedMonthly=num(R[0].totE)/12;
      const actualMonthly=num(spending.monthlyExpense);
      const delta=(actualMonthly-plannedMonthly)*12;
      if(plannedMonthly>0&&Math.abs(delta)>=materialAbs&&Math.abs(delta)/(plannedMonthly*12)>=materialPct){
        alerts.push(alert(KIND.DIVERGENCE,SEVERITY.WARNING,
          keyOf(KIND.DIVERGENCE,'spending',delta>0?'above':'below'),
          `Spending is running ${usd(Math.abs(delta))}/yr ${delta>0?'above':'below'} plan`,
          [ev('Plan',usd(plannedMonthly)+'/mo','projection totE ÷ 12'),
           ev('Actual',usd(actualMonthly)+'/mo',`${spending.completeMonths.length} complete months of transactions`),
           ev('Months averaged',spending.completeMonths.join(', '),'transaction ledger'),
           ev('Annualised difference',usd(delta),'computed')],
          `Spending compounds through every year of the projection. A gap of this size held for a decade moves the final figure by far more than it moves this year's.`,
          delta>0?`Either the plan's expense assumptions are too low, or this is a run of unusual months. Check the category breakdown before changing the plan.`
                 :`The plan may be over-reserving. Confirm the months are representative before spending the difference.`,
          {delta}));
      }
    }
    return{alerts,skipped};
  }

  // ── 5. Deadlines ─────────────────────────────────────────────────────────
  // Fixed dates, computed rather than remembered. Each fires inside a lead-time window and
  // stops firing once it has passed, so the inbox does not accumulate history.
  function deadlines(ctx){
    const{P,today,taxPlan}=ctx;
    const alerts=[],skipped=[];
    const now=today?new Date(today):new Date();
    const y=now.getFullYear();
    const daysTo=d=>Math.ceil((Date.parse(d)-now)/86400000);

    // Federal estimated tax instalments. The dates are statutory; whether they MATTER here
    // depends on the withholding gap, which is why the amount comes from taxPlan and the
    // alert is suppressed when there is nothing owed.
    const instalments=[
      {label:'Q1',due:`${y}-04-15`},{label:'Q2',due:`${y}-06-15`},
      {label:'Q3',due:`${y}-09-15`},{label:'Q4',due:`${y+1}-01-15`},
    ];
    const next=instalments.find(i=>daysTo(i.due)>=0);
    if(next){
      const d=daysTo(next.due);
      if(d<=45){
        if(!taxPlan||num(taxPlan.quarterlyPayment)==null){
          skipped.push(skip(KIND.DEADLINE,SKIP.NO_DATA,'withholding figures',
            `The ${next.label} estimated-tax instalment is due ${next.due}, but without your withholding to date there is no way to say whether a payment is required.`));
        } else if(num(taxPlan.quarterlyPayment)>0){
          alerts.push(alert(KIND.DEADLINE,d<=14?SEVERITY.CRITICAL:SEVERITY.WARNING,
            keyOf(KIND.DEADLINE,'estimatedTax',y,next.label),
            `${next.label} estimated tax of ${usd(taxPlan.quarterlyPayment)} is due ${next.due}`,
            [ev('Due date',next.due,'IRC § 6654 instalment dates'),
             ev('Days remaining',String(d),'computed'),
             ev('Instalment',usd(taxPlan.quarterlyPayment),'tax plan'),
             ev('Projected liability',usd(num(taxPlan.projectedLiability)),'tax engine'),
             ev('Withholding to date',usd(num(taxPlan.withheldToDate)),'entered')],
            `Underpaying an instalment adds interest under § 6654 even if the return is settled in full in April. The safe harbour is a floor, not a target.`,
            `Pay ${usd(taxPlan.quarterlyPayment)} by ${next.due}, or increase withholding for the rest of the year — withholding is treated as paid evenly across the year, so it can still cure an earlier shortfall.`,
            {dueDate:next.due}));
        }
      }
    }

    // Elective deferral. Only actionable while payroll can still be changed.
    const deferralLimit=num(P&&P.elective401kLimit)??num(ctx.taxRules&&ctx.taxRules.RULES.elective401kDeferral.value);
    const deferring=num(P&&P.pretax401k);
    if(deferralLimit!=null&&deferring!=null&&deferring<deferralLimit){
      const d=daysTo(`${y}-12-31`);
      if(d>=0&&d<=120)alerts.push(alert(KIND.DEADLINE,SEVERITY.INFO,
        keyOf(KIND.DEADLINE,'deferral',y),
        `${usd(deferralLimit-deferring)} of 401(k) room is unused for ${y}`,
        [ev('Contributing',usd(deferring),'plan setting pretax401k'),
         ev(`${y} limit`,usd(deferralLimit),'IRS Notice 2025-67 § 402(g)'),
         ev('Unused room',usd(deferralLimit-deferring),'computed'),
         ev('Days to year end',String(d),'computed')],
        `Deferral room does not carry forward. At the household's marginal rate the unused room is worth roughly ${usd((deferralLimit-deferring)*(num(ctx.marginalRate)??0.45))} of tax deferred, and it expires on 31 December.`,
        `Raise the payroll deferral for the remaining pay periods. Confirm the exact limit with payroll — catch-up eligibility and plan-specific caps can change it.`,
        {dueDate:`${y}-12-31`}));
    }

    // Tender windows. The only dates on which Stripe becomes cash.
    const tenderQuarters=(P&&P.stripeTenderQuarters)||[1,4];
    const q=Math.floor(now.getMonth()/3)+1;
    const nextTenderQ=tenderQuarters.find(t=>t>=q)??tenderQuarters[0];
    const tenderYear=nextTenderQ>=q?y:y+1;
    const tenderStart=`${tenderYear}-${String((nextTenderQ-1)*3+1).padStart(2,'0')}-01`;
    const dTender=daysTo(tenderStart);
    if(dTender>=0&&dTender<=60&&ctx.pendingStripeSale>0){
      alerts.push(alert(KIND.DEADLINE,SEVERITY.INFO,
        keyOf(KIND.DEADLINE,'tender',tenderYear,nextTenderQ),
        `The Q${nextTenderQ} ${tenderYear} tender opens in ${dTender} days`,
        [ev('Window opens',tenderStart,'plan setting stripeTenderQuarters'),
         ev('Sale the plan expects',usd(ctx.pendingStripeSale),'projection'),
         ev('Days remaining',String(dTender),'computed')],
        `This is one of two dates a year on which the position converts to cash. Missing it moves the money roughly six months.`,
        `Decide the sale size before the window opens rather than during it, and check the capital-gains cost first.`,
        {dueDate:tenderStart}));
    }
    return{alerts,skipped};
  }

  // ── 6. Decision review ───────────────────────────────────────────────────
  // A recorded decision carries the conditions under which it should be revisited. This
  // evaluates those conditions against the current state — it never re-opens a decision
  // because time passed or because a model felt uneasy about it.
  function decisionReview(ctx){
    const{decisions,today}=ctx;
    const alerts=[],skipped=[];
    if(!decisions||!decisions.length)return{alerts,skipped};
    const now=today?new Date(today):new Date();

    for(const d of decisions){
      if(d.status&&d.status!=='active')continue;
      for(const cond of d.reconsiderWhen||[]){
        const hit=evaluateCondition(cond,ctx);
        if(hit.status==='unknown'){
          skipped.push(skip(KIND.DECISION_REVIEW,SKIP.NO_DATA,hit.missing,
            `"${d.title}" should be revisited if ${cond.description}, but ${hit.missing} is not available to check that.`));
          continue;
        }
        if(!hit.triggered)continue;
        alerts.push(alert(KIND.DECISION_REVIEW,SEVERITY.WARNING,
          keyOf(KIND.DECISION_REVIEW,d.id,cond.id||cond.metric),
          `Revisit: ${d.title}`,
          [ev('Decided',d.decidedAt?isoDay(d.decidedAt):'—','decision log'),
           ev('Because',d.rationale||'—','decision log'),
           ev('Revisit if',cond.description,'decision log'),
           ev('Now',hit.actualLabel,hit.source),
           ev('Trigger',hit.thresholdLabel,'decision log')],
          `You decided this on a condition that no longer holds. The decision is not necessarily wrong now — but it was made against a picture that has changed, and it has not been looked at since.`,
          `Re-open the decision, or record that it still stands with a note about why the change does not matter.`,
          {decisionId:d.id,decidedAt:d.decidedAt}));
      }
      if(d.reviewBy&&Date.parse(d.reviewBy)<=now.getTime()){
        alerts.push(alert(KIND.DECISION_REVIEW,SEVERITY.INFO,
          keyOf(KIND.DECISION_REVIEW,d.id,'reviewBy'),
          `Scheduled review: ${d.title}`,
          [ev('Decided',d.decidedAt?isoDay(d.decidedAt):'—','decision log'),
           ev('Review by',isoDay(d.reviewBy),'decision log'),
           ev('Because',d.rationale||'—','decision log')],
          `You set this review date yourself when you made the decision.`,
          `Confirm the decision still holds, or record a new one.`,
          {decisionId:d.id}));
      }
    }
    return{alerts,skipped};
  }

  // A condition is {metric, op, value, description}. Metrics resolve out of the context, so
  // an unresolvable metric returns 'unknown' rather than quietly evaluating to false — a
  // silent false here would mean a decision never gets revisited and nobody knows why.
  const METRICS={
    stripeShare:ctx=>ctx.accounts&&num(ctx.accounts.netWorth)>0&&num(ctx.accounts.stripeVested)!=null
      ?{value:num(ctx.accounts.stripeVested)/num(ctx.accounts.netWorth),label:v=>pct(v),source:'live account balances'}
      :(ctx.R&&ctx.R.length?{value:ctx.R[0].sPct,label:v=>pct(v),source:'projection'}:null),
    netWorth:ctx=>ctx.accounts&&num(ctx.accounts.netWorth)!=null
      ?{value:num(ctx.accounts.netWorth),label:usd,source:'live account balances'}:null,
    liquidFloor:ctx=>ctx.R&&ctx.R.length
      ?{value:Math.min(...ctx.R.map(r=>r.liq)),label:usd,source:'projection'}:null,
    homePrice:ctx=>ctx.P&&num(ctx.P.homePrice)!=null
      ?{value:num(ctx.P.homePrice),label:usd,source:'plan setting'}:null,
    mortgageRate:ctx=>ctx.P&&num(ctx.P.mortgageRate)!=null
      ?{value:num(ctx.P.mortgageRate),label:v=>v.toFixed(2)+'%',source:'plan setting'}:null,
    monthlySpending:ctx=>ctx.spending&&num(ctx.spending.monthlyExpense)!=null
      ?{value:num(ctx.spending.monthlyExpense),label:usd,source:'transaction ledger'}:null,
    stripeReturn:ctx=>ctx.R&&ctx.R.length?{value:ctx.R[0].sRate,label:pct,source:'plan setting'}:null,
  };
  const OPS={
    gt:(a,b)=>a>b,gte:(a,b)=>a>=b,lt:(a,b)=>a<b,lte:(a,b)=>a<=b,
    changesBy:(a,b,base)=>base!=null&&Math.abs(a-base)>=b,
  };

  function evaluateCondition(cond,ctx){
    const resolver=METRICS[cond.metric];
    if(!resolver)return{status:'unknown',missing:`an unknown metric "${cond.metric}"`};
    const m=resolver(ctx);
    if(!m||m.value==null||!Number.isFinite(m.value))
      return{status:'unknown',missing:`the current value of ${cond.metric}`};
    const op=OPS[cond.op];
    if(!op)return{status:'unknown',missing:`an unknown comparison "${cond.op}"`};
    const triggered=cond.op==='changesBy'
      ?op(m.value,cond.value,cond.baseline)
      :op(m.value,cond.value);
    return{status:'ok',triggered,
      actualLabel:m.label(m.value),
      thresholdLabel:`${cond.op} ${m.label(cond.value)}`,
      source:m.source};
  }

  // ── Running everything ───────────────────────────────────────────────────
  const CHECKS=[reserveFloor,homeFunding,concentration,divergence,deadlines,decisionReview];

  function detect(ctx){
    const c=ctx||{};
    const alerts=[],skipped=[],failed=[];
    for(const check of CHECKS){
      try{
        const out=check(c)||{};
        for(const a of out.alerts||[])alerts.push({...a,detectedAt:c.today||isoDay(new Date())});
        for(const s of out.skipped||[])skipped.push(s);
      }catch(err){
        // A monitor that throws must not take the others with it, and must not be silently
        // counted as "clear" — a crashed check is an unknown, not an all-clear.
        failed.push({check:check.name,error:String(err&&err.message||err)});
      }
    }
    return{alerts,skipped,failed,
      checksRun:CHECKS.length-failed.length,checksTotal:CHECKS.length,
      generatedAt:c.today||isoDay(new Date())};
  }

  // ── State, dedup and priority ────────────────────────────────────────────
  // `states` maps an alert key to {state:'open'|'dismissed'|'snoozed'|'resolved', until,
  // note}. Applied here rather than at the database so the same rules hold in a test.
  function applyStates(alerts,states,today){
    const now=today?Date.parse(today):Date.now();
    const st=states||{};
    return alerts.map(a=>{
      const s=st[a.key];
      if(!s)return{...a,state:'open'};
      // A snooze that has run out is open again — silence has an expiry, unlike a dismissal.
      if(s.state==='snoozed'&&s.until&&Date.parse(s.until)<=now)
        return{...a,state:'open',wasSnoozedUntil:s.until};
      return{...a,state:s.state,stateNote:s.note,stateSince:s.since,until:s.until};
    });
  }

  // Two alerts with the same key are the same condition. Keep the first and count the rest,
  // so a caller can say "seen 4 times" without printing it four times.
  function dedupe(alerts){
    const seen=new Map();
    for(const a of alerts){
      const prior=seen.get(a.key);
      if(!prior)seen.set(a.key,{...a,occurrences:1});
      else prior.occurrences++;
    }
    return[...seen.values()];
  }

  // At most three. Attention is the scarce resource, and a list of eleven warnings is a
  // list of zero. Everything below the cut is still returned, just not as a priority.
  function prioritize(alerts,states,opts){
    const o=opts||{};
    const limit=o.limit??3;
    const withState=applyStates(dedupe(alerts),states,o.today);
    const visible=withState.filter(a=>a.state==='open');
    visible.sort((a,b)=>{
      const r=RANK[a.severity]-RANK[b.severity];
      if(r!==0)return r;
      // Within a severity, sooner beats later: a 2027 breach outranks a 2049 one.
      const ay=a.year??a.dueDate??'9999',by=b.year??b.dueDate??'9999';
      return String(ay)<String(by)?-1:String(ay)>String(by)?1:a.key<b.key?-1:1;
    });
    return{
      priorities:visible.slice(0,limit),
      more:visible.slice(limit),
      suppressed:withState.filter(a=>a.state!=='open'),
      counts:{open:visible.length,
        critical:visible.filter(a=>a.severity===SEVERITY.CRITICAL).length,
        warning:visible.filter(a=>a.severity===SEVERITY.WARNING).length,
        info:visible.filter(a=>a.severity===SEVERITY.INFO).length,
        suppressed:withState.length-visible.length},
    };
  }

  // What the advisor is allowed to talk about. Handing it the full detection output — the
  // skips and the failures included — is what stops it filling a silence with an invention:
  // it can say "this was not checked" because it was told which checks did not run.
  function briefingInput(detection,prioritized){
    return{
      generatedAt:detection.generatedAt,
      checksRun:detection.checksRun,checksTotal:detection.checksTotal,
      priorities:prioritized.priorities,
      alsoOpen:prioritized.more.map(a=>({key:a.key,title:a.title,severity:a.severity})),
      notChecked:detection.skipped,
      checksThatFailed:detection.failed,
      // Stated flatly so the advisor cannot present a clean run and a blind run identically.
      complete:detection.failed.length===0&&detection.skipped.length===0,
    };
  }

  const api={SEVERITY,KIND,SKIP,METRICS,OPS,
    reserveFloor,homeFunding,concentration,divergence,deadlines,decisionReview,
    evaluateCondition,detect,applyStates,dedupe,prioritize,briefingInput,keyOf};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerMonitors=api;
})(typeof window!=='undefined'?window:this);
