'use strict';
// ═══ THE YEAR TURNING ═══
// Pure and shared by browser and Node, like model.js and opening.js.
//
// A plan built in September 2026 models the months still ahead of the day its balances were
// read. On 1 January that plan is describing a year that has finished, and every figure on
// every screen quietly becomes a projection of the past.
//
// Two things happen at that boundary, and they are deliberately separate:
//
//   1. The plan ROLLS FORWARD — every rolling window shifts a year, opening balances re-read
//      from the accounts. plan-migrate.js already does this and is tested for it.
//   2. The closing year gets a SCORECARD — what the plan said would happen, against what the
//      accounts actually report. This module.
//
// Neither happens on its own. A year boundary is a bad moment to be surprised by your own
// plan having changed, so this decides only whether the moment has ARRIVED; a person decides
// whether to take it.
//
// What makes a scorecard honest is that it compares like with like. The planned figure is
// the projection for the year that just ended, on the basis the accounts can actually
// observe: the house is not in a brokerage feed, so a line the accounts cannot see is marked
// as unobservable rather than scored against zero.

(function(root){

  const r0=v=>Math.round(Number(v)||0);
  const fin=v=>Number.isFinite(Number(v));

  // Has the plan's start year fallen behind the calendar? Deliberately not "is it January" —
  // a plan opened in 2026 and left untouched until March 2027 is just as stale, and a person
  // who skipped the prompt in January should still be offered it in March.
  function rollForwardDue(P,today){
    const sy=Number((P||{}).planStartYear)||0;
    const now=today==null?new Date():(today instanceof Date?today:new Date(today));
    if(!sy||!Number.isFinite(now.getTime()))return null;
    const year=now.getFullYear();
    if(year<=sy)return null;
    return{closingYear:sy,currentYear:year,yearsBehind:year-sy};
  }

  // The lines of a scorecard. `planned` is the projected row for the closing year; `observed`
  // is the account summary as it stands now.
  //
  // Every line says which of three things it is:
  //   scored        both sides known, the difference is real
  //   unobservable  the plan models it, the accounts cannot see it (home equity)
  //   unknown       the accounts should see it but did not report it
  function lines(planned,observed){
    const s=observed||{};
    const ret=Number(s.byClass&&s.byClass.retirement?s.byClass.retirement.total:NaN);
    const out=[];
    const add=(key,label,plan,actual,note,kind)=>{
      if(kind==='unobservable'){out.push({key,label,planned:r0(plan),actual:null,diff:null,kind,note});return}
      if(!fin(plan)||!fin(actual)){out.push({key,label,planned:fin(plan)?r0(plan):null,actual:fin(actual)?r0(actual):null,diff:null,kind:'unknown',note});return}
      out.push({key,label,planned:r0(plan),actual:r0(actual),diff:r0(actual)-r0(plan),kind:'scored',note});
    };

    add('liquid','Cash + taxable',planned&&planned.liq,s.accessible,
      'The diversified pool the plan compounds.');
    add('stripe','Vested Stripe',planned&&planned.sEnd,s.stripeVested,
      'Vests that landed, less anything sold, at the tender price.');
    add('retirement','Retirement',planned&&planned.k401,ret,
      'Contributions, the match, and return on the balance already there.');
    // The plan carries home equity; a brokerage feed does not. Scoring it against a zero the
    // accounts never claimed would invent a miss that did not happen.
    if(planned&&Number(planned.eq)>0)
      add('home','Home equity',planned.eq,null,'Not visible to your accounts — the plan carries it, the feed does not.','unobservable');

    const scored=out.filter(l=>l.kind==='scored');
    // The total is summed from the lines that were actually scored, so it cannot claim to
    // cover something no line measured.
    const plannedTotal=scored.reduce((a,l)=>a+l.planned,0);
    const actualTotal=scored.reduce((a,l)=>a+l.actual,0);
    return{lines:out,scored:scored.length,
      plannedTotal,actualTotal,diff:actualTotal-plannedTotal,
      complete:out.every(l=>l.kind!=='unknown')};
  }

  // A scorecard for the year that just closed. Returns null rather than a hollow card when
  // there is nothing to score — no projection for that year, or no balances to score against.
  function scorecard(opts){
    const o=opts||{};
    const year=Number(o.year);
    const R=o.R||[];
    const planned=R.find(r=>Number(r.yr)===year);
    if(!planned)return null;
    const s=o.observed;
    if(!s||!o.accountsAvailable)return{year,available:false,
      reason:'No account balances to score the year against.'};
    const body=lines(planned,s);
    if(!body.scored)return{year,available:false,reason:'Nothing in the plan matched what the accounts report.'};
    const verdict=body.diff===0?'exactly as planned'
      :body.diff>0?`${money(body.diff)} ahead of plan`:`${money(-body.diff)} behind plan`;
    return{year,available:true,...body,verdict,
      observedOn:o.observedOn||null,
      // A year scored against balances read weeks after it closed is scored against a
      // different day than the one the projection describes. Said, not silently absorbed.
      driftDays:driftDays(year,o.observedOn)};
  }

  function driftDays(year,observedOn){
    if(!observedOn)return null;
    const on=Date.parse(String(observedOn).slice(0,10)+'T00:00:00Z');
    if(!Number.isFinite(on))return null;
    return Math.round((on-Date.UTC(year+1,0,1))/86400000);
  }

  function money(v){
    const a=Math.abs(r0(v));
    return '$'+a.toLocaleString('en-US');
  }

  const api={rollForwardDue,scorecard,lines};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerYearEnd=api;
})(typeof window!=='undefined'?window:this);
