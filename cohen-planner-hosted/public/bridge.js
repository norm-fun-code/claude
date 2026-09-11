'use strict';
// ═══ THE BRIDGE: OBSERVED NET WORTH ↔ PROJECTED YEAR-END NET WORTH ═══
// Pure and shared by browser and Node, like model.js and accounts.js.
//
// The cockpit shows two large numbers and calls both of them net worth. They do not agree,
// and until now the page never said why. There are three separate reasons, and lumping them
// together is what makes the mismatch look like a bug in one of them:
//
//  1. COMPOSITION. Observed net worth is every account you hold. The projection models
//     diversified liquid, vested Stripe, retirement, home equity and a flat revolving
//     balance. An account you have not classified is real money the projection still has no
//     bucket for, so comparing the totals compares different sets of assets.
//
//     This was once much worse: the engine carried no debt at all beyond the mortgage, so
//     the trajectory line was modelled ASSETS while the page called it net worth. That was a
//     defect, not a difference of perspective, and it is fixed in model.js rather than
//     explained away here. What remains under composition is only genuinely unmodelled.
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
  function comparableObserved(summary,exRetirement){
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
    // A cockpit showing net worth ex-retirement has to be reconciled ex-retirement, on both
    // sides. Dropping it from only one would make the bridge fail to close by exactly the
    // 401(k) — the very error the bridge exists to expose.
    const counted=exRetirement?0:retirement;
    return{
      accessible,stripe,retirement,privateOther,unclassified,debt,exRetirement:!!exRetirement,
      // Debt belongs INSIDE the comparable subset now that the projection carries a flat
      // revolving balance. It was previously added back as something the model simply did
      // not have, which made a real liability look like a difference of definition.
      comparable:accessible+stripe+counted+privateOther-debt,
      // Signed: this is what has to be added to the comparable subset to get back to the
      // net worth on the hero.
      outside:unclassified,
    };
  }

  // ── The plan's opening position ──────────────────────────────────────────
  // Where the projection starts the selected year from — the previous row's close, or the
  // typed starting assumptions when the selected year is the first one modelled.
  function openingPosition(R,year,P,exRetirement){
    const rows=R||[];
    const prev=rows.find(r=>r.yr===year-1);
    if(prev)return{value:r0(exRetirement?prev.nw:prev.netWorth),source:'prior year close',year:year-1};
    const p=P||{};
    return{value:r0((p.startingLiquid||0)+(p.startingStripeEquity||0)
      +(exRetirement?0:(p.k401Start||0))-Math.abs(Number(p.otherDebt||0))),
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

    const ex=!!o.exRetirement;
    const projected=r0(ex?row.nw:row.netWorth);
    // Without accounts there is nothing to bridge FROM. The projection still stands on its
    // own; it simply has no observation to be reconciled against.
    if(!summary||!o.accountsAvailable)
      return{available:false,projected,
        reason:'Account balances are unavailable, so there is nothing to compare the projection against.'};

    const c=comparableObserved(summary,ex);
    const observed=r0(ex?summary.netWorth-c.retirement:summary.netWorth);
    const opening=openingPosition(R,year,P,ex);
    const planGap=c.comparable-opening.value;
    const withinYear=projected-opening.value;

    const lines=[];
    // The two endpoints carry no delta: they are the numbers already on the page, and a
    // signed step beside them would invite reading the anchor as a movement.
    lines.push({kind:'observed',key:'observed',
      label:ex?'Net worth in your accounts, outside retirement':'Net worth in your accounts',
      value:null,running:observed,
      note:ex?`Every account you hold except retirement, which holds a further ${fmt(c.retirement)}.`
        :'Every account you hold, as last reported.'});

    if(c.unclassified)lines.push({kind:'composition',key:'unclassified',
      label:'Accounts not yet classified',value:-c.unclassified,
      note:'Real money, but the projection has no bucket for it until it is classified.',
      action:'classify'});
    // Only worth a row when something was actually set aside above it. With nothing
    // unclassified it restates the line before it verbatim, and a subtotal that repeats its
    // own input reads as a rounding error the reader then goes looking for.
    if(c.unclassified)lines.push({kind:'comparable',key:'comparable',
      label:'The part your plan models',value:null,running:c.comparable,
      note:'Cash, taxable, vested Stripe, retirement and any private holding, less what you owe — the things the projection tracks.'});

    // The plan gap splits cleanly into the assets side and the debt side, because they are
    // reconciled by different controls and one of them is easy to leave at zero forever.
    const planDebt=Math.abs(Number(P.otherDebt||0));
    const debtGap=planDebt-c.debt;
    const assetGap=planGap-debtGap;
    const fromAssumptions=opening.source==='your starting assumptions';
    const carried=`Carried forward from the modelled close of ${opening.year}, which was itself built on your starting assumptions.`;

    if(debtGap)lines.push({kind:'plan',key:'debtGap',
      label:planDebt?'Revolving balance your plan carries':'Revolving balance your plan is not carrying',
      value:-debtGap,running:r0(c.comparable-debtGap),
      note:fromAssumptions
        ?`You owe ${fmt(c.debt)} today and the projection carries ${fmt(planDebt)}. Cards cleared monthly are float — a permanent offset, not a debt that amortises — so the plan should hold the balance you typically carry.`
        :carried,
      action:'reconcile'});

    if(assetGap)lines.push({kind:'plan',key:'planGap',
      label:`What your plan assumes it starts ${year} with`,
      value:-assetGap,running:opening.value,
      note:fromAssumptions
        ?'Your typed starting figures differ from what your accounts report. Every year after this one inherits the difference.'
        :carried,
      action:'reconcile'});

    lines.push({kind:'time',key:'withinYear',
      label:`Saving and assumed return through ${year}`,value:withinYear,running:projected,
      note:'The chart reads 31 December. Today is not.'});

    lines.push({kind:'projected',key:'projected',
      label:`${year} year-end net worth${ex?' ex-retirement':''}`,
      value:null,running:projected,
      note:'Future dollars, at your assumed rates. Not a forecast.'});

    // The single sentence the chart needs. Composition and time are expected and permanent;
    // only the plan gap is a disagreement anyone can act on.
    const composition=-c.unclassified;
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
