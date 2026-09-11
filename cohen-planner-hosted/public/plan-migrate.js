'use strict';
// ═══ SAVED-STATE MIGRATION + ROLL FORWARD ═══
// Pure functions, shared by the browser (<script>) and Node (tests). Saved plans in the
// wild span four generations of the compensation schema, so migration runs as an ordered
// chain — each stage upgrades one generation and leaves the next stage's input well-formed.
//
// The overriding rule: migrating an existing plan must never change its projected TAXES or
// its total STARTING net worth. Only the cash-vs-asset behaviour of stock is allowed to
// change, because that is the whole point of the split.
(function(root){
  const NORM_YEARS=11;   // normCashY0..Y10 / normStockY0..Y10
  const STRIPE_RET_YEARS=10;

  // Gen 1 → Gen 2: absolute year keys (normCash2026) → rolling index keys (normCashY0).
  function migrateYearKeys(raw){
    if(raw.normCashY0!==undefined||raw.normTCY0!==undefined)return raw;
    const sy=raw.planStartYear||raw.startYear||2026;
    const m={...raw,planStartYear:sy};
    const oldNormCash={2026:280000,2027:260000,2028:275000,2029:265000};
    const oldNormStock={2026:197000,2027:162000,2028:153000,2029:158000};
    const oldNancyW2={2026:130000,2027:80000,2028:100000,2029:75000};
    for(let i=0;i<4;i++){
      const yr=sy+i;
      m['normCashY'+i]=raw['normCash'+yr]??oldNormCash[yr]??275000;
      m['normStockY'+i]=raw['normStock'+yr]??oldNormStock[yr]??150000;
      m['nancyW2Y'+i]=raw['nancyW2_'+yr]??oldNancyW2[yr]??100000;
    }
    m.normCashBase=raw.normCash2030Base??raw.normCashBase??275000;
    m.normStockBase=raw.normStock2030??raw.normStockBase??150000;
    return m;
  }

  // Gen 2/3 → Gen 4: produce a full 11 years of SEPARATE cash + stock.
  //
  // Gen 3 (normTCY#) collapsed the two streams into one total. That migration never deleted
  // the underlying normCashY#/normStockY#/normCashBase/normStockBase keys, so the real split
  // is usually still recoverable rather than invented. Where it isn't recoverable — because
  // the user edited a total after the collapse — we preserve THEIR total exactly (so tax is
  // untouched) and apportion it using that year's own legacy stock ratio, flagging the plan
  // for review rather than silently asserting a split we don't actually know.
  function migrateCompSplit(m){
    const hasTotals=m.normTCY0!==undefined;
    if(!hasTotals&&m['normCashY'+(NORM_YEARS-1)]!==undefined)return m; // already Gen 4
    const growth=m.normGrowth??0.01;
    const cashBase=m.normCashBase??275000,stockBase=m.normStockBase??150000;
    const out={...m};
    let needsReview=false;
    for(let i=0;i<NORM_YEARS;i++){
      // Best split we actually have evidence for. Years 0–3 were stored explicitly; years
      // 4+ reproduce the pre-collapse base+growth formula (cash grew, stock stayed flat).
      let cash=i<4?(m['normCashY'+i]??cashBase):cashBase*(1+growth)**(i-4);
      let stock=i<4?(m['normStockY'+i]??stockBase):stockBase;
      const total=m['normTCY'+i];
      if(total!==undefined){
        const legacyTotal=cash+stock;
        if(Math.abs(legacyTotal-total)>1){
          const ratio=legacyTotal>0?stock/legacyTotal:0.35;
          stock=Math.round(total*ratio);
          cash=total-stock;
          needsReview=true;
        }
      }
      out['normCashY'+i]=Math.round(cash);
      out['normStockY'+i]=Math.round(stock);
    }
    for(let i=0;i<NORM_YEARS;i++)delete out['normTCY'+i];
    if(out.normStockGrowth===undefined)out.normStockGrowth=growth;
    // Never auto-populate Stripe equity: every existing plan already carries its whole net
    // worth inside startingLiquid, so seeding this from a synced balance would double-count.
    if(out.startingStripeEquity===undefined)out.startingStripeEquity=0;
    // The floor graduated from a single policy's setting to the reserve the whole funding
    // waterfall defends, so it is no longer Stripe-specific. Carry the old value forward.
    if(out.liquidReserveFloor===undefined)out.liquidReserveFloor=out.stripeLiquidFloor??500000;
    if(needsReview)out.normSplitNeedsReview=1;
    return out;
  }

  // Gen: 3-phase nanny/daycare → one flat childcare rate.
  function migrateChildcare(m){
    if(m.childcareMonthly!==undefined)return m;
    if(m.daycareMonthly===undefined&&m.nannyHourlyRate===undefined)return m;
    return{...m,childcareMonthly:m.daycareMonthly??Math.round((m.nannyHourlyRate??30)*9*(m.nannyDaysPerWeek??4)*52/12)};
  }

  function migrateP(raw){
    if(!raw||typeof raw!=='object')return raw;
    return migrateObservedOn(migrateChildcare(migrateCompSplit(migrateYearKeys(raw))));
  }

  // When were these opening balances true? Every plan written before this existed answered
  // implicitly "1 January", which is what the engine assumed and is almost never right: a
  // plan built in September then ran a full year of income, spending, saving and return on
  // top of balances that already contained eight months of it.
  //
  // A saved plan keeps whatever date it recorded. One that has never had a date is stamped
  // with today, because that IS when its figures were last looked at — and the field is
  // editable, so a plan genuinely built from January statements can say so.
  function migrateObservedOn(P,today){
    if(P.observedOn!==undefined)return P;
    const now=today?new Date(today):new Date();
    const sy=P.planStartYear||2026;
    // A date outside the first plan year tells the engine nothing it can use: before it,
    // the whole year is ahead; after it, the year is already over. Only stamp a date that
    // actually falls inside the year being stubbed.
    if(now.getFullYear()!==sy)return{...P,observedOn:null};
    const iso=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    return{...P,observedOn:iso};
  }

  // Advance the plan one year. Every rolling per-year window is indexed off planStartYear,
  // so each one has to shift in lockstep or it would silently re-point at the wrong year.
  function rollForwardParams(P){
    const out={...P};
    const last=NORM_YEARS-1;
    for(let i=0;i<last;i++){
      out['normCashY'+i]=P['normCashY'+(i+1)];
      out['normStockY'+i]=P['normStockY'+(i+1)];
    }
    // The incoming final year is exactly what the model's own post-window growth formula
    // already projects for it, so the roll introduces no discontinuity.
    out['normCashY'+last]=Math.round((P['normCashY'+last]??275000)*(1+(P.normGrowth??0.01)));
    out['normStockY'+last]=Math.round((P['normStockY'+last]??150000)*(1+(P.normStockGrowth??P.normGrowth??0.01)));
    // Stripe return assumptions are also indexed off the start year; the vacated final slot
    // inherits the long-term rate, which is what that year would have used anyway.
    for(let i=0;i<STRIPE_RET_YEARS-1;i++)out['stripeRetY'+i]=P['stripeRetY'+(i+1)];
    out['stripeRetY'+(STRIPE_RET_YEARS-1)]=P.stripeLongTermReturn??0.08;
    // Nancy's Y3 has no steady-state base field to pull from, and the ramp formula yields 0
    // clients in every year it's actually read, so grow it with the plan's inflation instead
    // of freezing it or injecting a spurious $0.
    out.nancyW2Y0=P.nancyW2Y1;out.nancyW2Y1=P.nancyW2Y2;out.nancyW2Y2=P.nancyW2Y3;
    out.nancyW2Y3=Math.round(P.nancyW2Y3*(1+(P.expenseInflation??0.03)));
    // The observation date belonged to the year just rolled past. Carrying it into the new
    // start year would leave the engine computing a stub from a date that is now BEFORE the
    // plan opens — which reads as "the whole year is ahead", silently undoing the roll's
    // intent for anyone who then re-observes. Cleared, so it is set again deliberately.
    out.observedOn=null;
    out.planStartYear=(P.planStartYear||2026)+1;
    return out;
  }

  const api={migrateP,rollForwardParams,migrateYearKeys,migrateCompSplit,migrateChildcare,migrateObservedOn,NORM_YEARS,STRIPE_RET_YEARS};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlanMigrate=api;
})(typeof window!=='undefined'?window:this);
