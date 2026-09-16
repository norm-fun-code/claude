'use strict';
// ═══ OPENING BALANCES THAT FOLLOW THE ACCOUNTS ═══
// Pure and shared by browser and Node, like model.js and accounts.js.
//
// The plan's opening figures — liquid, vested Stripe, retirement, revolving debt — used to
// be typed by hand while the same numbers sat in the accounts panel, observed. Keeping two
// copies of one fact means one of them is always wrong, and the bridge spent its life
// reporting the difference between them.
//
// So they follow the accounts by default. What this module exists to get right is WHEN they
// must not:
//
//   • Accounts unreachable. No observation, nothing to follow. Hold the last value.
//   • Totals incomplete. A balance the provider failed to return makes the bucket short by
//     an unknown amount, and following a short figure understates the plan silently.
//   • Nothing classified into the bucket. An empty bucket reports zero, and zero is
//     indistinguishable from "you have not classified the account yet". Writing that zero
//     over a real plan figure erases it on the strength of a classification gap — the same
//     trap accounts.reconcile() already refuses, and for the same reason.
//
// In every one of those cases the field HOLDS its last value and says why. It is never
// blanked, and a missing balance is never read as nothing.
//
// `manual` opts a field out entirely, which is what makes a what-if possible: to ask "what
// if my Stripe position were twice this", the figure has to be able to stop tracking.

(function(root){

  const FIELDS=[
    {key:'startingLiquid',label:'Diversified liquid',
     read:s=>Number(s.accessible)||0,
     backing:s=>cnt(s,'cash')+cnt(s,'taxable'),
     note:'cash + taxable brokerage, excluding Stripe and retirement'},
    {key:'startingStripeEquity',label:'Vested Stripe equity',
     read:s=>Number(s.stripeVested)||0,
     backing:s=>vestedStripeCount(s),
     note:'accounts you have classified as vested Stripe'},
    {key:'k401Start',label:'Retirement',
     read:s=>total(s,'retirement'),
     backing:s=>cnt(s,'retirement'),
     note:'every retirement account, including a Stripe 401(k)'},
    {key:'otherAssets',label:'Other private assets',
     read:s=>Math.max(0,total(s,'private')-(Number(s.stripeVested)||0)),
     backing:s=>Math.max(0,cnt(s,'private')-vestedStripeCount(s)),
     note:'private holdings that are not vested Stripe — they compound at the portfolio return, but are never counted as spendable'},
    {key:'otherDebt',label:'Revolving balance',
     read:s=>Number(s.debt)||0,
     backing:s=>cnt(s,'debt'),
     note:'cards and other non-mortgage debt, held flat across every year'},
  ];
  const grp=(s,k)=>(s&&s.byClass&&s.byClass[k])||{total:0,accounts:[]};
  const cnt=(s,k)=>(grp(s,k).accounts||[]).length;
  const total=(s,k)=>Number(grp(s,k).total)||0;
  const vestedStripeCount=s=>Object.values((s&&s.byClass)||{})
    .reduce((n,g)=>n+((g.accounts||[]).filter(a=>a.stripeKind==='vested').length),0);

  function mode(P,key){
    const src=P&&P.openingSource;
    return src&&src[key]==='manual'?'manual':'auto';
  }

  // What each field would read from the accounts, and whether it may.
  function observedOpening(P,summary,available){
    const s=summary||{};
    return FIELDS.map(f=>{
      const planValue=Math.abs(Number((P||{})[f.key]||0));
      const value=Math.round(Math.abs(f.read(s)));
      const backing=f.backing(s);
      const m=mode(P,f.key);
      let ok=true,reason=null;
      if(m==='manual'){ok=false;reason='You set this one yourself.'}
      else if(!available){ok=false;reason='Account balances are unavailable, so this is holding its last value.'}
      else if(s.complete===false){ok=false;reason='Some balances could not be read, so the totals are short by an unknown amount. Holding the last value rather than following a short one.'}
      // The zero that is really a classification gap. Identical rule to the reconciliation
      // panel: a bucket with nothing in it reports zero whether it is empty or unclassified,
      // and only one of those should overwrite a real figure.
      else if(value===0&&planValue!==0&&backing===0){
        ok=false;reason='No account is classified into this bucket, so its zero is a gap in classification rather than an observed balance. Classify the right account and this will follow it.';
      }
      return{key:f.key,label:f.label,note:f.note,mode:m,value,planValue,backing,
        following:ok,changes:ok&&value!==planValue,reason};
    });
  }

  // Returns the plan with every following field set to what the accounts report. Pure: it
  // builds a new object and never mutates the one it was given.
  function syncOpening(P,summary,available){
    const rows=observedOpening(P,summary,available);
    const next={...(P||{})};
    const changed=[],held=[];
    for(const r of rows){
      if(r.following){ if(r.changes){next[r.key]=r.value;changed.push(r)} }
      else if(r.mode!=='manual')held.push(r);
    }
    return{P:next,rows,changed,held,dirty:changed.length>0};
  }

  // Flipping one field between following the accounts and being typed by hand. Turning
  // tracking back ON does not itself write a value — syncOpening does that on the next pass,
  // under all the same guards.
  function setMode(P,key,m){
    if(!FIELDS.some(f=>f.key===key))return P;
    const src={...((P&&P.openingSource)||{})};
    if(m==='manual')src[key]='manual';else delete src[key];
    return{...P,openingSource:src};
  }

  // ── What a saved case may and may not keep ───────────────────────────────
  // A case is a set of ASSUMPTIONS — returns, spending, when you buy. What you own today is
  // not an assumption, it is an observation, and freezing it into a case means the case
  // projects from whatever you happened to hold on the day you saved it. That is how
  // "Conservative" came to show 2026 ending BELOW today: it was still starting from a
  // balance sheet with no Stripe equity in it, months after the accounts had reported some.
  //
  // Comparing two cases should compare two futures, not two different starting points.
  //
  // The exception is a figure the reader took by hand. `Set by hand` exists so a case CAN
  // ask "what if my Stripe position were twice this" — that is a genuine assumption and it
  // travels with the case. Only fields still following the accounts are dropped.
  const VALUE_KEYS=FIELDS.map(f=>f.key);
  function stripObserved(params){
    const out={...(params||{})};
    const src=out.openingSource||{};
    for(const k of VALUE_KEYS)if(src[k]!=='manual')delete out[k];
    // When the balances were read is never a choice, so it never travels with a case.
    delete out.observedOn;
    if(!Object.keys(out.openingSource||{}).length)delete out.openingSource;
    return out;
  }
  // Re-attach today's observation to a case as it is loaded. Legacy cases that still carry
  // baked-in balances are healed here too: anything not marked manual is overwritten by the
  // live figure rather than trusted.
  function withObserved(params,live){
    const out={...(params||{})};
    const src=out.openingSource||{};
    const l=live||{};
    for(const k of VALUE_KEYS)if(src[k]!=='manual'&&Object.prototype.hasOwnProperty.call(l,k))out[k]=l[k];
    if(Object.prototype.hasOwnProperty.call(l,'observedOn'))out.observedOn=l.observedOn;
    return out;
  }

  const api={FIELDS:FIELDS.map(f=>({key:f.key,label:f.label,note:f.note})),VALUE_KEYS,
    observedOpening,syncOpening,setMode,mode,stripObserved,withObserved};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerOpening=api;
})(typeof window!=='undefined'?window:this);
