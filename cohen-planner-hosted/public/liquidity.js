'use strict';
// ═══ STRIPE SALE ELIGIBILITY & TIMING ═══
// Pure, shared by browser and Node.
//
// The planner has been assuming vested Stripe can be turned into cash whenever it is needed.
// That is not true of private stock, and the difference is not cosmetic: an annual model can
// report a year fully funded while the money is unreachable in the month the cheque clears.
//
// Confirmed by the user for this household:
//   • Tender offers run in Q1 and Q4 — twice a year, on a predictable cadence.
//   • A standing election converts part of the grant to cash at $20K per quarter,
//     roughly $80K a year, available in every quarter rather than only tender windows.
//
// Everything else is modelled as an assumption and labelled as one. In particular the model
// applies NO cap on how much may be sold into a tender, because the user has not stated one
// — an invented cap would silently understate what is fundable.

(function(root){

  const usd=v=>'$'+Math.round(v).toLocaleString('en-US');

  const DEFAULTS={
    tenderQuarters:[1,4],           // confirmed: Q1 and Q4
    electiveCashPerQuarter:20000,   // confirmed: standing quarterly cash election
    electiveCashAnnualCap:80000,    // confirmed: about $80K a year in total
    tenderCapPerEvent:null,         // unknown — null means "no cap modelled", not "no cap exists"
    liquidityFromYear:null,         // optional: a year from which stock becomes freely sellable
  };

  const cfg=p=>({
    tenderQuarters:(p&&p.stripeTenderQuarters)||DEFAULTS.tenderQuarters,
    electiveCashPerQuarter:p&&p.stripeElectiveCashPerQuarter!=null?Number(p.stripeElectiveCashPerQuarter):DEFAULTS.electiveCashPerQuarter,
    electiveCashAnnualCap:p&&p.stripeElectiveCashAnnualCap!=null?Number(p.stripeElectiveCashAnnualCap):DEFAULTS.electiveCashAnnualCap,
    tenderCapPerEvent:p&&p.stripeTenderCapPerEvent!=null?Number(p.stripeTenderCapPerEvent):DEFAULTS.tenderCapPerEvent,
    liquidityFromYear:p&&p.stripeLiquidityFromYear!=null?Number(p.stripeLiquidityFromYear):DEFAULTS.liquidityFromYear,
  });

  // Is the stock freely sellable in this year — i.e. has a liquidity event happened?
  function freelyLiquid(year,p){
    const c=cfg(p);
    return c.liquidityFromYear!=null&&year>=c.liquidityFromYear;
  }

  // The windows in one year, in order, each with what it can raise.
  //   tender   — sell held stock; capped only if the user supplies a cap
  //   elective — the standing quarterly cash election, available every quarter
  // `heldValue` is the stock on hand at the start of the year; `vestPerQuarter` is what
  // lands each quarter and becomes eligible from that quarter onward.
  function saleWindows(year,{heldValue=0,vestPerQuarter=0}={},p){
    const c=cfg(p);
    const free=freelyLiquid(year,p);
    const out=[];
    let eligible=heldValue;          // stock that could be sold, growing as vests land
    let electiveUsed=0;
    for(let q=1;q<=4;q++){
      eligible+=vestPerQuarter;      // this quarter's vest becomes eligible
      if(free){
        out.push({quarter:q,kind:'open',cap:eligible,
          note:'a liquidity event has occurred, so stock is freely sellable'});
        continue;
      }
      const isTender=c.tenderQuarters.includes(q);
      if(isTender){
        const cap=c.tenderCapPerEvent==null?eligible:Math.min(eligible,c.tenderCapPerEvent);
        out.push({quarter:q,kind:'tender',cap,
          note:c.tenderCapPerEvent==null
            ?'tender window — no participation cap has been confirmed, so none is modelled'
            :`tender window — capped at ${c.tenderCapPerEvent} per event`});
      }
      // The elective cash-out runs in every quarter, including tender quarters, but the
      // annual cap is shared across all four.
      const electiveRoom=Math.max(0,c.electiveCashAnnualCap-electiveUsed);
      const elective=Math.min(c.electiveCashPerQuarter,electiveRoom,eligible);
      if(elective>0){
        out.push({quarter:q,kind:'elective',cap:elective,
          note:'standing quarterly cash election'});
        electiveUsed+=elective;
      }
    }
    return out;
  }

  // Cumulative cash raisable from Stripe by the END of a given quarter.
  // This is the number an annual model hides: the year's total can be ample while the
  // amount reachable by Q2 is a fraction of it.
  function raisableBy(year,quarter,ctx,p){
    const windows=saleWindows(year,ctx,p);
    let total=0;
    for(const w of windows){
      if(w.quarter>quarter)continue;
      total+=w.cap;
    }
    // Selling the same shares twice is not possible: the cumulative total can never exceed
    // the stock that has actually become eligible by that quarter.
    const c=cfg(p);
    const eligibleByQ=(ctx&&ctx.heldValue||0)+(ctx&&ctx.vestPerQuarter||0)*quarter;
    return Math.min(total,eligibleByQ);
  }

  function raisableInYear(year,ctx,p){return raisableBy(year,4,ctx,p)}

  // Can a specific need be met by a specific quarter, and if not, what is short?
  function fundingCheck({year,quarter,need,heldValue=0,vestPerQuarter=0,otherCash=0},p){
    const fromStripe=raisableBy(year,quarter,{heldValue,vestPerQuarter},p);
    const available=fromStripe+Number(otherCash||0);
    const shortfall=Math.max(0,Number(need||0)-available);
    const windows=saleWindows(year,{heldValue,vestPerQuarter},p).filter(w=>w.quarter<=quarter);
    const nextWindow=saleWindows(year,{heldValue,vestPerQuarter},p).find(w=>w.quarter>quarter&&w.kind!=='elective');
    return{
      year,quarter,need:Number(need||0),otherCash:Number(otherCash||0),
      fromStripe,available,shortfall,fundable:shortfall<=0,
      windowsUsed:windows,
      // What would fix a shortfall, stated rather than left to be inferred.
      nextWindow:nextWindow?{quarter:nextWindow.quarter,kind:nextWindow.kind}:null,
      remedy:shortfall<=0?null:
        nextWindow?`Wait for the Q${nextWindow.quarter} ${nextWindow.kind}, or cover ${usd(shortfall)} from the portfolio.`
                  :`No further Stripe window this year — ${usd(shortfall)} must come from the portfolio or be deferred.`,
    };
  }

  // Which quarter a purchase closes in. Nothing in the annual model records this, so it is
  // asked for rather than inferred; the default is stated openly.
  function purchaseQuarter(p){
    const q=p&&p.homePurchaseQuarter!=null?Number(p.homePurchaseQuarter):null;
    return q&&q>=1&&q<=4?q:2; // a spring close is the stated default, not a derived fact
  }

  const api={DEFAULTS,cfg,freelyLiquid,saleWindows,raisableBy,raisableInYear,fundingCheck,purchaseQuarter};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerLiquidity=api;
})(typeof window!=='undefined'?window:this);
