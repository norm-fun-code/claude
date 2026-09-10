'use strict';
// ═══ SNAPSHOT CHANGE EXPLANATION ═══
// Pure, shared by browser and Node.
//
// The rule this module exists to enforce: a balance moving is an OBSERVATION, and by itself
// it establishes nothing about why. Net worth rising $40K might be market gains, a bonus, a
// transfer in from an account we do not sync, or a stale price finally refreshing. A cockpit
// that labels the difference "investment performance" is inventing a fact.
//
// So changes are decomposed only as far as recorded transactions actually support, and
// whatever is left over is named as a residual — never as performance. The residual is the
// honest part of the answer, not a rounding error to be dressed up.

(function(root){

  const CONFIDENCE={
    MEASURED:'measured',    // taken directly from recorded transactions
    RESIDUAL:'residual',    // the leftover; a difference, not a measurement
    UNSUPPORTED:'unsupported', // no data to make any claim at all
  };

  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
  const dayMs=864e5;

  // Does the transaction ledger actually cover the window between two snapshots?
  // Partial coverage is treated as no coverage for attribution purposes: explaining half a
  // window and calling the rest performance is worse than admitting the gap, because the
  // number looks authoritative either way.
  function windowCoverage(from,to,ledgerRange){
    if(!from||!to)return{covered:false,reason:'need two snapshots to compare'};
    const a=Date.parse(from.asOf),b=Date.parse(to.asOf);
    if(!Number.isFinite(a)||!Number.isFinite(b))return{covered:false,reason:'snapshot dates are unreadable'};
    if(!ledgerRange||!ledgerRange.firstDate||!ledgerRange.lastDate)
      return{covered:false,reason:'no transaction history imported',days:Math.round((b-a)/dayMs)};
    const lo=Date.parse(ledgerRange.firstDate),hi=Date.parse(ledgerRange.lastDate+'T23:59:59Z');
    const days=Math.round((b-a)/dayMs);
    if(lo>a)return{covered:false,days,reason:`transaction history starts ${ledgerRange.firstDate}, after this window opens`};
    if(hi<b)return{covered:false,days,reason:`transaction history ends ${ledgerRange.lastDate}, before this window closes`};
    return{covered:true,days,reason:null};
  }

  // Decompose the change in net worth between two snapshots.
  //
  // `flows` comes from the classified ledger for exactly this window:
  //   income      — money that arrived as pay or similar
  //   spending    — consumption, net of refunds
  //   investment  — moved into investment accounts (shifts WHERE wealth sits, not how much)
  // Transfers and card payments are deliberately absent: they move money between the
  // household's own accounts and change net worth by zero, so including them would create
  // offsetting phantom components.
  function explainChange(from,to,flows,ledgerRange){
    const cov=windowCoverage(from,to,ledgerRange);
    const delta=num(to&&to.netWorth)-num(from&&from.netWorth);
    const out={
      from:from?from.asOf:null,to:to?to.asOf:null,delta,
      days:cov.days!=null?cov.days:null,components:[],residual:null,coverage:cov,
    };

    if(!cov.covered){
      // No decomposition at all. The change is real and observed; the reason is not known,
      // and no part of it may be attributed to anything.
      out.residual={amount:delta,confidence:CONFIDENCE.UNSUPPORTED,
        label:'Not explained',
        detail:`Your balances moved ${delta>=0?'up':'down'}, but ${cov.reason}. A balance change on its own cannot show whether that was earnings, spending, market movement or a transfer.`};
      return out;
    }

    const income=num(flows&&flows.income);
    const spending=num(flows&&flows.spending);
    if(income)out.components.push({key:'income',label:'Income received',amount:income,
      confidence:CONFIDENCE.MEASURED,detail:'from recorded transactions'});
    if(spending)out.components.push({key:'spending',label:'Spending',amount:-spending,
      confidence:CONFIDENCE.MEASURED,detail:'consumption, net of refunds'});

    const explained=income-spending;
    const residual=delta-explained;
    out.components.push({key:'netFlow',label:'Net from income and spending',amount:explained,
      confidence:CONFIDENCE.MEASURED,detail:'what your cash flow alone accounts for'});
    out.residual={
      amount:residual,confidence:CONFIDENCE.RESIDUAL,
      label:'Not explained by transactions',
      // Even with full coverage this is a residual, not a measurement. It absorbs market
      // movement, but also unsynced accounts, price staleness, valuation changes on private
      // holdings and anything the provider mis-categorised — so it is described as
      // consistent with market movement rather than declared to be it.
      detail:`What is left after cash flow. Consistent with market and valuation movement on ${money(to)} of holdings, but it also absorbs anything not captured as a transaction — an unsynced account, a stale price, or a revaluation. It is a difference, not a measured return.`,
    };
    return out;
  }
  function money(s){const v=num(s&&s.netWorth);return v>=1e6?'$'+(v/1e6).toFixed(2)+'M':'$'+Math.round(v).toLocaleString()}

  // Per-class movement, which is observation rather than attribution and therefore always
  // safe to show: it says WHERE the change landed, and claims nothing about why.
  function classDeltas(from,to){
    const keys=new Set([...Object.keys((from&&from.byClass)||{}),...Object.keys((to&&to.byClass)||{})]);
    const rows=[];
    for(const k of keys){
      const a=num(from&&from.byClass&&from.byClass[k]&&from.byClass[k].total);
      const b=num(to&&to.byClass&&to.byClass[k]&&to.byClass[k].total);
      if(a===0&&b===0)continue;
      rows.push({cls:k,from:a,to:b,delta:b-a});
    }
    return rows.sort((x,y)=>Math.abs(y.delta)-Math.abs(x.delta));
  }

  // A snapshot is only comparable if it recorded a complete picture. One taken while an
  // account had no balance is missing an unknown amount, so differencing it would attribute
  // that gap to something real.
  function comparable(snap){
    if(!snap)return{ok:false,reason:'missing'};
    if(snap.complete===false)return{ok:false,reason:'taken while an account had no balance, so its total is short by an unknown amount'};
    if(!Number.isFinite(Number(snap.netWorth)))return{ok:false,reason:'no net worth recorded'};
    return{ok:true,reason:null};
  }

  const api={CONFIDENCE,windowCoverage,explainChange,classDeltas,comparable};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerSnapshots=api;
})(typeof window!=='undefined'?window:this);
