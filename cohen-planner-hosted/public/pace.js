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
//    when it swings $1,500. The band is built from the prior months themselves, and the
//    range is reported in dollars, because "$2,400–$3,400 is normal for you by the 12th"
//    is actionable and "47% above" is not.
//
//    It is built from PERCENTILES OF THE LAST TWELVE MONTHS, not mean ± one standard
//    deviation over all history. Both parts of that were wrong, and they compounded:
//
//      A standard deviation is inflated by the very outliers it is meant to see past. One
//      $2,400 charitable gift two years ago widens the band for every judgement after it —
//      the more unusual a month was, the less this notices the next one. On real data that
//      produced a "normal range" of $1,782–$10,516 against a typical of $6,149: a band
//      1.4x as wide as the figure it describes, which no month could fall outside. And
//      ±1 SD is a coin flip anyway — a third of months sit outside it by construction,
//      so it was never the "normal range" it was labelled as.
//
//      Twenty-four months is not this household either. A plan with a baby arriving and
//      income that has moved is not measured against the year before last.
//
//    So: the centre is the MEDIAN of the trailing twelve months at this day, which a single
//    unusual month cannot move, and the band is the 20th to 80th percentile — "six of your
//    last ten months landed in this range by now", which is a sentence that means something.
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
  // Linear-interpolated percentile over a sorted copy. Robust where mean and standard
  // deviation are not: one enormous month moves a percentile by one position and a mean by
  // its whole size.
  function percentile(a,q){
    const v=(a||[]).filter(Number.isFinite).slice().sort((x,y)=>x-y);
    if(!v.length)return 0;
    if(v.length===1)return v[0];
    const i=(v.length-1)*Math.min(1,Math.max(0,q));
    const lo=Math.floor(i),hi=Math.ceil(i);
    return lo===hi?v[lo]:v[lo]+(v[hi]-v[lo])*(i-lo);
  }
  const median=a=>percentile(a,0.5);
  // Where this month sits among the prior ones: 0 means below all of them, 1 above all.
  // Ties count as half, so a month exactly equal to its history reads as the middle rather
  // than the top.
  function rankOf(value,sample){
    const v=(sample||[]).filter(Number.isFinite);
    if(!v.length)return 0.5;
    let below=0,equal=0;
    for(const x of v){ if(x<value)below++; else if(x===value)equal++; }
    return (below+equal/2)/v.length;
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
  // Where this month sits AMONG the prior ones, as a rank from 0 to 1 — not how many
  // standard deviations from their mean. The old thresholds called anything inside ±0.6 SD
  // "about normal", and with an SD inflated by its own outliers that swallowed a month
  // running 32% hot. A rank cannot be inflated: being above eight of your last twelve
  // months is being above eight of your last twelve months.
  //
  // The middle band is p30–p70 — four months in ten are "about normal" — because the point
  // of this card is to be worth reading, and a verdict that is almost always "normal" is
  // not. It is still generous enough that ordinary variation is not an alarm.
  const BANDS=[
    {max:0.10,verdict:'well below',tone:'good'},
    {max:0.30,verdict:'below',tone:'good'},
    {max:0.70,verdict:'about',tone:'neutral'},
    {max:0.90,verdict:'above',tone:'warn'},
    {max:Infinity,verdict:'well above',tone:'bad'},
  ];
  const bandFor=rank=>BANDS.find(b=>rank<b.max)||BANDS[BANDS.length-1];

  // How much history the range is built from. Twelve months: long enough to hold a seasonal
  // swing, short enough to still be this household.
  const WINDOW_MONTHS=12;
  // The percentiles the "normal range" spans, and the narrowest it may get. A household
  // whose months barely vary would otherwise be told a $60 difference is well above normal.
  const BAND_LO=0.20,BAND_HI=0.80;
  const floorWidth=typical=>Math.max(typical*0.10,100);

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
    // The trailing window, most recent first in the slice: the last twelve complete months,
    // or everything there is if the ledger is shorter.
    const windowMonths=Math.max(1,Number(o.windowMonths)||WINDOW_MONTHS);
    const allPriors=[...byMonth.keys()].filter(m=>m<thisMonth).sort();
    const priors=allPriors.slice(-windowMonths);

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
      monthsAvailable:allPriors.length,committedRule,
      note:'Pace cannot be judged yet. Nothing here is a verdict.'};

    // The comparison, at the same day of month in every prior month of the window.
    const priorAtDay=priors.map(m=>byMonth.get(m).days[day]);
    const mtd=current.days[day];
    // Median, not mean: a single $2,400 gift should not move what "typical" means.
    const typical=median(priorAtDay);
    // The band, widened to a floor so a very consistent household is not told that sixty
    // dollars is a finding. Widening moves both edges around the median, keeping it centred.
    const rawLow=percentile(priorAtDay,BAND_LO),rawHigh=percentile(priorAtDay,BAND_HI);
    const half=Math.max((rawHigh-rawLow)/2,floorWidth(typical));
    const normalLow=Math.max(0,typical-half),normalHigh=typical+half;
    // THE RANGE DRAWN IS THE VERDICT. A card that shades a month green and calls it "well
    // above normal" in the same breath has told the reader to trust neither. So the band is
    // decided first, and the rank only grades how far past its edge this month is.
    //
    // Rank alone could not do this: a household whose months are near-identical has every
    // month above all twelve of its predecessors by a few dollars, and rank 1.0 would call
    // sixty dollars "well above" while the drawn range said it was fine.
    const rank=rankOf(mtd,priorAtDay);
    const band=mtd>normalHigh?bandFor(Math.max(rank,0.75))
      :mtd<normalLow?bandFor(Math.min(rank,0.25))
      :bandFor(0.5);
    // Kept for anything still reading it, and for the evidence line: how far from typical
    // in units of the band's own half-width.
    const spread=half;
    const z=half>0?(mtd-typical)/half:0;

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
      // Median and rank here too. A category is where the outliers actually live — charity
      // running $2,911 against $233 in a normal month is exactly the shape that inflates a
      // standard deviation until nothing can ever be unusual again.
      const cTypical=median(hist);
      const cRank=rankOf(now,hist);
      const cSpread=Math.max((percentile(hist,BAND_HI)-percentile(hist,BAND_LO))/2,cTypical*0.2,40);
      const over=now-cTypical;
      drivers.push({category:name,mtd:now,typical:cTypical,over,rank:cRank,
        z:cSpread>0?(now-cTypical)/cSpread:0,
        shareOfGap:gap>0?over/gap:0,
        // Two tests, and it needs both. Unusual for itself — above at least four fifths of
        // the months in the window — and material.
        //
        // Material is a fifth of the gap or $250, whichever is smaller, so a modest month
        // still surfaces its own drivers — but never less than $100 whatever the gap. On a
        // month running dead normal that share collapses towards nothing, and a category
        // that moved twenty-four dollars was being named as the thing driving it.
        flagged:cRank>=0.8&&over>0&&over>=Math.max(100,Math.min(250,Math.abs(gap)*0.2)),
      });
    }
    drivers.sort((a,b)=>b.over-a.over);
    // Only flagged categories get an explanation: the others are noise by construction, and
    // explaining noise is how a reader learns to skip the explanations.
    const priorMonths=priors.map(m=>byMonth.get(m));
    for(const d of drivers)if(d.flagged)d.explain=explainDriver(d.category,d.over,current,priorMonths,day);

    return{
      status:'ok',asOf,month:thisMonth,day,
      mtd,typical,sd:spread,z,rank,
      verdict:band.verdict,tone:band.tone,
      // The normal range in dollars. "$2,400–$3,400 is normal for you by the 12th" is
      // something a person can act on; "47% above" is not.
      normalLow,normalHigh,
      // What the range is, so the card can say it rather than asserting "normal".
      bandPct:[BAND_LO,BAND_HI],windowMonths,
      // How many of the window's months this one is running above — the plainest possible
      // statement of the same fact, and the one worth printing.
      monthsAbove:priorAtDay.filter(v=>mtd>v).length,
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

  const api={COMMITTED,BANDS,WINDOW_MONTHS,BAND_LO,BAND_HI,isCommitted,cumulate,pace,bandFor,
    mean,stdev,percentile,median,rankOf,explainDriver};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerPace=api;
})(typeof window!=='undefined'?window:this);
