'use strict';
// ═══ DISCRETIONARY PACE ═══
// Pure, shared by the browser, the server and the tests. Answers one question: is this
// month's controllable spending running hot, and what is driving it?
//
// Three decisions make this honest rather than merely alarming.
//
// 1. COMPARE LIKE WITH LIKE, BY DAY OF MONTH. "Typical at this point" cannot be a monthly
//    average scaled by the fraction of the month elapsed: spending is not uniform. Rent,
//    tuition and subscriptions land on the 1st, so a linear pro-rate says you are 300%
//    over on the 2nd of every month. We have transaction dates, so the comparison is
//    against what had actually been spent by the SAME DAY in prior months.
//
// 2. "ABOVE TYPICAL" MEANS OUTSIDE YOUR OWN RANGE, not above an arbitrary percentage.
//    A household whose months swing by $2,000 either way is not having an unusual month
//    when it swings $1,500. The band is built from the dispersion of the prior months
//    themselves, and the range is reported in dollars, because "$2,400–$3,400 is normal
//    for you by the 12th" is actionable and "47% above" is not.
//
// 3. DISCRETIONARY IS DECLARED, NOT INFERRED. Committed costs — housing, tuition, care,
//    insurance, utilities, debt service — are not a spending decision this month, and
//    including them buries the signal. The rule is explicit, listed in the output, and
//    overridable, because one household's "gym" is another's fixed commitment.

(function(root){

  // ── What is not a decision you made this month ───────────────────────────
  // Matched on Monarch's category NAME, since these are stable user-facing labels and the
  // group taxonomy does not distinguish committed from discretionary.
  const COMMITTED=[
    {key:'housing',test:/rent|mortgage|property\s*tax|hoa|home\s*insurance/i},
    {key:'education',test:/tuition|yeshiva|school|college|529/i},
    {key:'childcare',test:/child\s*care|childcare|daycare|nanny|babysit/i},
    {key:'insurance',test:/insurance|premium/i},
    {key:'utilities',test:/utilit|electric|gas\s*bill|water|internet|phone|cable/i},
    {key:'debt',test:/loan|student\s*loan|auto\s*pay|car\s*payment|interest/i},
    {key:'taxes',test:/\btax(es)?\b|irs|estimated\s*payment/i},
    {key:'medical',test:/medical|health|doctor|dental|pharmacy|therapy/i},
  ];

  function isCommitted(name,opts){
    const o=opts||{};
    const n=String(name||'');
    // An explicit list always wins. A household knows its own commitments better than a
    // regular expression does.
    if(o.discretionaryCategories&&o.discretionaryCategories.length)
      return !o.discretionaryCategories.some(c=>String(c).toLowerCase()===n.toLowerCase());
    if(o.committedCategories&&o.committedCategories.length)
      return o.committedCategories.some(c=>String(c).toLowerCase()===n.toLowerCase());
    return COMMITTED.some(r=>r.test.test(n));
  }

  const dayOf=iso=>Number(String(iso||'').slice(8,10))||0;
  const monthOf=iso=>String(iso||'').slice(0,7);
  const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
  function stdev(a){
    if(a.length<2)return 0;
    const m=mean(a);
    return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1));
  }

  // ── Cumulative discretionary spend by day of month ───────────────────────
  // Returns {month -> {day -> cumulative}} plus a per-category breakdown, in one pass.
  function cumulate(txns,cats,opts){
    const o=opts||{};
    const byMonth=new Map();
    for(const t of txns||[]){
      const kind=o.classify?o.classify(t):null;
      // Only real consumption counts. Transfers, card payments and investments are not
      // spending, and a refund nets down the category it came from.
      if(kind&&kind!=='expense'&&kind!=='refund')continue;
      const amt=Number(t.amount||0);
      const spend=-amt;                       // expenses are negative in the ledger
      if(!Number.isFinite(spend)||spend===0)continue;
      const cat=(cats&&t.categoryId!=null&&cats.get?cats.get(String(t.categoryId)):null);
      const name=(cat&&cat.name)||t.categoryName||'Uncategorised';
      if(isCommitted(name,o))continue;
      const mk=monthOf(t.date),d=dayOf(t.date);
      if(!mk||!d)continue;
      if(!byMonth.has(mk))byMonth.set(mk,{month:mk,days:new Array(32).fill(0),cats:new Map(),items:[]});
      const m=byMonth.get(mk);
      m.days[d]+=spend;
      if(!m.cats.has(name))m.cats.set(name,new Array(32).fill(0));
      m.cats.get(name)[d]+=spend;
      // Kept so a flagged category can say WHAT moved it. "Clothing is up $330" tells you
      // where to look; "a single H&M purchase is most of it" tells you whether to care.
      m.items.push({cat:name,merchant:(t.merchant||t.plaidName||t.name||'').trim(),
        spend,day:d,date:t.date});
    }
    // Turn per-day into running totals, so "by the 12th" is one lookup.
    for(const m of byMonth.values()){
      for(let d=1;d<=31;d++)m.days[d]+=m.days[d-1];
      for(const arr of m.cats.values())for(let d=1;d<=31;d++)arr[d]+=arr[d-1];
    }
    return byMonth;
  }

  // ── Verdict bands ────────────────────────────────────────────────────────
  // Built from the household's own dispersion. z is how many standard deviations this
  // month sits from its own history at the same point.
  const BANDS=[
    {max:-1.5,verdict:'well below',tone:'good'},
    {max:-0.6,verdict:'below',tone:'good'},
    {max:0.6,verdict:'about',tone:'neutral'},
    {max:1.5,verdict:'above',tone:'warn'},
    {max:Infinity,verdict:'well above',tone:'bad'},
  ];
  const bandFor=z=>BANDS.find(b=>z<b.max)||BANDS[BANDS.length-1];

  // ── Why a category is up ─────────────────────────────────────────────────
  // A category name and a dollar figure leave the reader to open their statement. What they
  // actually want to know is whether it was ONE thing or a pattern — a sofa is not a habit,
  // and a habit is not a sofa. Those call for opposite responses, and the difference is
  // visible in the ledger.
  //
  // Three honest answers, and the third is the important one:
  //   one-off   — a single purchase from a merchant with no history here covers most of it
  //   more of the same — the biggest merchant is one you buy from every month
  //   spread    — nothing dominates, so no culprit is offered rather than inventing one
  function explainDriver(name,over,current,priorMonths,day){
    const items=(current.items||[]).filter(t=>t.cat===name&&t.day<=day&&t.spend>0);
    if(!items.length||!(over>0))return null;
    // Merchants seen in this category in any PRIOR month — the test for "new to you".
    const seen=new Map();
    for(const m of priorMonths){
      for(const t of (m.items||[])){
        if(t.cat!==name||!t.merchant)continue;
        seen.set(t.merchant.toLowerCase(),(seen.get(t.merchant.toLowerCase())||0)+1);
      }
    }
    const byMerchant=new Map();
    for(const t of items){
      const k=t.merchant||'Uncategorised merchant';
      if(!byMerchant.has(k))byMerchant.set(k,{merchant:k,total:0,count:0,largest:0,date:t.date});
      const e=byMerchant.get(k);
      e.total+=t.spend;e.count++;
      if(t.spend>e.largest){e.largest=t.spend;e.date=t.date}
    }
    const ranked=[...byMerchant.values()].sort((a,b)=>b.total-a.total);
    const top=ranked[0];
    const share=top.total/over;
    const priorCount=seen.get((top.merchant||'').toLowerCase())||0;
    const familiar=priorCount>0;
    // "Most of it" has to mean something. Two thirds, or it is not most of it.
    const dominates=share>=0.66;
    let kind='spread',sentence;
    const money=v=>'$'+Math.round(v).toLocaleString('en-US');
    if(dominates&&!familiar&&top.count===1){
      kind='one-off';
      sentence=`a one-time ${top.merchant} purchase of ${money(top.largest)} is most of it`;
    } else if(dominates&&familiar){
      kind='more of the same';
      sentence=`${top.merchant}, which you spend on most months, is most of it — ${money(top.total)} across ${top.count} purchase${top.count===1?'':'s'}`;
    } else if(dominates){
      kind='one-off';
      sentence=`${top.count} purchase${top.count===1?'':'s'} at ${top.merchant} totalling ${money(top.total)} is most of it`;
    } else {
      sentence=`no single purchase explains it — ${ranked.length} merchant${ranked.length===1?'':'s'}, the largest ${top.merchant} at ${money(top.total)}`;
    }
    return{kind,sentence,merchant:top.merchant,amount:top.total,largest:top.largest,
      count:top.count,date:top.date,shareOfOver:share,merchantsInvolved:ranked.length,
      seenInPriorMonths:priorCount,newToYou:!familiar,
      top:ranked.slice(0,3).map(r=>({merchant:r.merchant,total:Math.round(r.total),count:r.count}))};
  }

  // ── The headline ─────────────────────────────────────────────────────────
  function pace(txns,cats,opts){
    const o=opts||{};
    const asOf=o.asOf||new Date().toISOString().slice(0,10);
    const thisMonth=monthOf(asOf);
    const day=dayOf(asOf);
    const minMonths=o.minMonths??3;

    const byMonth=cumulate(txns,cats,o);
    const current=byMonth.get(thisMonth);
    // Prior COMPLETE months only. The month in progress is not a data point, and the
    // most recent complete month is still a sample of one.
    const priors=[...byMonth.keys()].filter(m=>m<thisMonth).sort();

    const needs=[];
    if(priors.length<minMonths)needs.push({
      field:'completeMonths',
      have:priors.length,need:minMonths,
      why:`A normal range needs at least ${minMonths} complete months to measure against. There ${priors.length===1?'is':'are'} ${priors.length}.`,
    });
    if(!current)needs.push({field:'currentMonth',
      why:`No transactions have landed in ${thisMonth} yet.`});

    // The committed rule is reported even when there is nothing to judge: "no
    // discretionary spending" and "everything is on your committed list" look identical
    // in the output otherwise.
    const committedRule=o.committedCategories?'your list'
      :o.discretionaryCategories?'your list':'default pattern';
    if(needs.length)return{status:'insufficient',needs,asOf,month:thisMonth,day,
      monthsAvailable:priors.length,committedRule,
      note:'Pace cannot be judged yet. Nothing here is a verdict.'};

    // The comparison, at the same day of month in every prior month.
    const priorAtDay=priors.map(m=>byMonth.get(m).days[day]);
    const typical=mean(priorAtDay);
    const sd=stdev(priorAtDay);
    const mtd=current.days[day];
    // With no dispersion at all, any difference is infinitely surprising, which is not a
    // useful thing to say. Fall back to a proportional band.
    const spread=sd>1?sd:Math.max(typical*0.15,50);
    const z=(mtd-typical)/spread;
    const band=bandFor(z);

    const lastMonthKey=priors[priors.length-1];
    const lastAtDay=byMonth.get(lastMonthKey).days[day];

    // ── Drivers ────────────────────────────────────────────────────────────
    // A category is flagged when it is BOTH unusual for itself and a material part of
    // the gap. Either test alone produces noise: a category that doubles from $20 to $40
    // is unusual and irrelevant, and a large category drifting 5% is neither.
    const gap=mtd-typical;
    const names=new Set();
    for(const m of [current,...priors.map(p=>byMonth.get(p))])
      for(const n of m.cats.keys())names.add(n);
    const drivers=[];
    for(const name of names){
      const now=(current.cats.get(name)||[])[day]||0;
      const hist=priors.map(p=>(byMonth.get(p).cats.get(name)||[])[day]||0);
      const cTypical=mean(hist),cSd=stdev(hist);
      const cSpread=cSd>1?cSd:Math.max(cTypical*0.2,40);
      const cZ=(now-cTypical)/cSpread;
      const over=now-cTypical;
      drivers.push({category:name,mtd:now,typical:cTypical,over,z:cZ,
        shareOfGap:gap>0?over/gap:0,
        // Material means it moves the headline: a fifth of the gap, or $250, whichever
        // is smaller, so a modest month still surfaces its own drivers.
        flagged:cZ>1&&over>0&&(over>=Math.min(250,Math.abs(gap)*0.2)),
      });
    }
    drivers.sort((a,b)=>b.over-a.over);
    // Only flagged categories get an explanation: the others are noise by construction, and
    // explaining noise is how a reader learns to skip the explanations.
    const priorMonths=priors.map(m=>byMonth.get(m));
    for(const d of drivers)if(d.flagged)d.explain=explainDriver(d.category,d.over,current,priorMonths,day);

    return{
      status:'ok',asOf,month:thisMonth,day,
      mtd,typical,sd:spread,z,
      verdict:band.verdict,tone:band.tone,
      // The normal range in dollars. "$2,400–$3,400 is normal for you by the 12th" is
      // something a person can act on; "47% above" is not.
      normalLow:Math.max(0,typical-spread),normalHigh:typical+spread,
      over:mtd-typical,
      overPct:typical>0?(mtd-typical)/typical:null,
      lastMonth:{month:lastMonthKey,atDay:lastAtDay,
        deltaPct:lastAtDay>0?(mtd-lastAtDay)/lastAtDay:null},
      monthsCompared:priors.length,monthsUsed:priors,
      drivers,flagged:drivers.filter(d=>d.flagged),
      // The one line worth putting under the headline figure, when there is one.
      headlineDriver:(()=>{
        const f=drivers.filter(d=>d.flagged);
        if(!f.length)return null;
        const d=f[0];
        return{category:d.category,over:d.over,shareOfGap:d.shareOfGap,
          label:`Driven by ${d.category} +${'$'+Math.round(d.over).toLocaleString('en-US')}`,
          explain:d.explain};
      })(),
      committedRule,
      committedKinds:COMMITTED.map(c=>c.key),
    };
  }

  const api={COMMITTED,BANDS,isCommitted,cumulate,pace,bandFor,mean,stdev,explainDriver};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerPace=api;
})(typeof window!=='undefined'?window:this);
