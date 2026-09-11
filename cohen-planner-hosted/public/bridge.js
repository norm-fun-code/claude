'use strict';
// ═══ THE BRIDGE: OBSERVED NET WORTH ↔ PROJECTED YEAR-END WEALTH ═══
// Pure and shared by browser and Node, like model.js and accounts.js.
//
// The cockpit shows two large numbers and calls both of them wealth. They do not agree, and
// until now the page never said why. There are three separate reasons, and lumping them
// together is what makes the mismatch look like a bug in one of them:
//
//  1. COMPOSITION. Observed net worth is every account you hold. The projection models four
//     things — diversified liquid, vested Stripe, retirement, home equity — and nothing
//     else. A credit-card balance and an unclassified account are both real and both absent
//     from the projection. Comparing the totals compares different sets of assets.
//
//  2. STARTING POINT. The plan opens from assumptions you typed. Your accounts report what
//     is actually there. When those disagree, every year of the projection inherits the
//     difference. This is the one that is usually meant by "the numbers are wrong", and the
//     only honest response is to show the gap and offer to reconcile it — never to rebase
//     the plan silently.
//
//  3. TIME. The hero is today. The chart's first point is 31 December. A year of saving and
//     assumed return sits between them by construction, and would still sit there if
//     everything else matched perfectly.
//
// This module computes all three as separate, signed lines that add up. Nothing here
// changes the plan or the projection; it only explains the distance between them.

(function(root){

  const r0=v=>Math.round(Number(v)||0);

  // ── The comparable subset ────────────────────────────────────────────────
  // What the observed accounts hold that the projection actually models. Everything else is
  // named and set aside rather than quietly netted off, because "your plan does not model
  // this" and "your plan disagrees about this" are different problems with different fixes.
  function comparableObserved(summary){
    const s=summary||{};
    const cls=k=>(s.byClass&&s.byClass[k]?Number(s.byClass[k].total)||0:0);
    const accessible=Number(s.accessible)||0;      // cash + taxable
    const stripe=Number(s.stripeVested)||0;
    const retirement=cls('retirement');
    // Private holdings that are NOT vested Stripe: a home, a stake in something. The
    // projection's only private asset is home equity, so this is where they land.
    const privateOther=cls('private')-stripe;
    const unclassified=cls('unknown');
    const debt=Number(s.debt)||0;
    return{
      accessible,stripe,retirement,privateOther,unclassified,debt,
      comparable:accessible+stripe+retirement+privateOther,
      // Signed: this is what has to be added to the comparable subset to get back to the
      // net worth on the hero.
      outside:unclassified-debt,
    };
  }

  // ── The plan's opening position ──────────────────────────────────────────
  // Where the projection starts the selected year from — the previous row's close, or the
  // typed starting assumptions when the selected year is the first one modelled.
  function openingPosition(R,year,P){
    const rows=R||[];
    const prev=rows.find(r=>r.yr===year-1);
    if(prev)return{value:r0(prev.nw+prev.k401),source:'prior year close',year:year-1};
    const p=P||{};
    return{value:r0((p.startingLiquid||0)+(p.startingStripeEquity||0)+(p.k401Start||0)),
      source:'your starting assumptions',year:null};
  }

  // ── The bridge ───────────────────────────────────────────────────────────
  // Returns lines that sum, in order, from the observed hero figure to the projected
  // year-end figure on the chart. `kind` says which of the three causes each line is, so the
  // UI can colour and act on them differently — only `plan` is something to reconcile.
  function bridge(opts){
    const o=opts||{};
    const summary=o.summary,R=o.R||[],P=o.P||{};
    const year=o.year!=null?Number(o.year):(R[0]&&R[0].yr);
    const row=R.find(r=>r.yr===year);
    if(!row)return{available:false,reason:'That year is not in the projection.'};

    const projected=r0(row.nw+row.k401);
    // Without accounts there is nothing to bridge FROM. The projection still stands on its
    // own; it simply has no observation to be reconciled against.
    if(!summary||!o.accountsAvailable)
      return{available:false,projected,
        reason:'Account balances are unavailable, so there is nothing to compare the projection against.'};

    const c=comparableObserved(summary);
    const observed=r0(summary.netWorth);
    const opening=openingPosition(R,year,P);
    const planGap=c.comparable-opening.value;
    const withinYear=projected-opening.value;

    const lines=[];
    // The two endpoints carry no delta: they are the numbers already on the page, and a
    // signed step beside them would invite reading the anchor as a movement.
    lines.push({kind:'observed',key:'observed',label:'Net worth in your accounts',
      value:null,running:observed,
      note:'Every account you hold, as last reported.'});

    if(c.unclassified)lines.push({kind:'composition',key:'unclassified',
      label:'Accounts not yet classified',value:-c.unclassified,
      note:'Real money, but the projection has no bucket for it until it is classified.',
      action:'classify'});
    // Added BACK, which looks wrong until you see what it is for: we are stepping from your
    // real net worth toward a projection that has no card or loan in it. The projection is
    // the thing missing the debt, and this line is where that omission is stated.
    if(c.debt)lines.push({kind:'composition',key:'debt',
      label:'Debt your projection never carried',value:c.debt,
      note:'Cards and loans genuinely reduce your net worth. The projection models only a mortgage, so this is added back to reach a figure built the same way.',
      action:null});

    lines.push({kind:'comparable',key:'comparable',label:'The part your plan models',
      value:null,running:c.comparable,
      note:'Cash, taxable, vested Stripe, retirement and any private holding — the four things the projection tracks.'});

    if(planGap)lines.push({kind:'plan',key:'planGap',
      label:`What your plan assumes it starts ${year} with`,
      value:-planGap,running:opening.value,
      note:opening.source==='your starting assumptions'
        ?'Your typed starting figures differ from what your accounts report. Every year after this one inherits the difference.'
        :`Carried forward from the modelled close of ${opening.year}, which was itself built on your starting assumptions.`,
      action:'reconcile'});

    lines.push({kind:'time',key:'withinYear',
      label:`Saving and assumed return through ${year}`,value:withinYear,running:projected,
      note:'The chart reads 31 December. Today is not.'});

    lines.push({kind:'projected',key:'projected',label:`${year} year-end wealth`,
      value:null,running:projected,
      note:'Future dollars, at your assumed rates. Not a forecast.'});

    // The single sentence the chart needs. Composition and time are expected and permanent;
    // only the plan gap is a disagreement anyone can act on.
    const composition=-c.unclassified+c.debt;
    const headline=Math.abs(planGap)<1000
      ?`Your plan starts ${year} within $1k of what your accounts show. The rest of the difference is ${year} saving and return.`
      :planGap>0
        ?`Your accounts hold ${fmt(planGap)} MORE than your plan assumes it starts ${year} with, so the projection understates every year after this one.`
        :`Your plan assumes it starts ${year} with ${fmt(-planGap)} MORE than your accounts hold, so the projection overstates every year after this one.`;

    return{available:true,observed,comparable:c.comparable,opening:opening.value,projected,
      planGap:r0(planGap),composition:r0(composition),withinYear:r0(withinYear),
      aligned:Math.abs(planGap)<1000,lines,headline,parts:c,
      // Hidden and missing balances both make the observed side unreliable, in opposite
      // directions, and neither is the plan's fault. Say so rather than presenting an exact
      // bridge built on an inexact figure.
      caveats:[
        summary.complete===false?`${(summary.unknownBalance||[]).length} account balance${(summary.unknownBalance||[]).length===1?'':'s'} could not be read, so the observed side is short by an unknown amount.`:null,
        summary.hiddenCount&&summary.hiddenNet?`${fmt(Math.abs(summary.hiddenNet))} sits in hidden accounts and is excluded from the observed side.`:null,
      ].filter(Boolean)};
  }

  function fmt(v){
    const n=Math.round(Math.abs(Number(v)||0));
    return (Number(v)<0?'−$':'$')+n.toLocaleString('en-US');
  }

  const api={bridge,comparableObserved,openingPosition};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerBridge=api;
})(typeof window!=='undefined'?window:this);
