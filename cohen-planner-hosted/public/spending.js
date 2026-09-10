'use strict';
// ═══ SPENDING & CASH FLOW — PURE ACCOUNTING ═══
// Shared by the browser (<script>) and Node (tests), like model.js. No DOM, no I/O.
//
// The whole point of this file is that "what did we spend" is NOT "sum the transactions".
// A household's ledger double-counts by construction: moving money between your own accounts
// looks like two transactions, paying a credit card looks like spending on top of the
// purchases it settles, and a refund looks like income. Getting those three wrong inflates
// or deflates every downstream number — budgets, averages, anomaly flags, and the projection
// changes they would justify. So classification happens once, here, with tests.

(function(root){

  // ── Classification ───────────────────────────────────────────────────────
  // Monarch's own taxonomy drives this: each category belongs to a group, and the group
  // carries a `type` of income / expense / transfer. We lean on that rather than matching
  // merchant names, which breaks the moment a merchant is renamed.
  const KIND={
    EXPENSE:'expense',        // real consumption — counts against a budget
    INCOME:'income',          // pay, interest, dividends received as cash
    TRANSFER:'transfer',      // between the household's own accounts — NOT spending
    CARD_PAYMENT:'cardPayment', // settles a card balance — NOT spending, the purchases were
    INVESTMENT:'investment',  // money moved into/out of brokerage — saving, not consumption
    REFUND:'refund',          // money back on a prior expense — nets DOWN a category
    EXCLUDED:'excluded',      // hidden from reports, or a split parent whose children we have
  };

  // System categories Monarch ships. Matched on its stable `systemCategory` slug where
  // present, falling back to the display name only as a last resort.
  const SYSTEM_TRANSFER=new Set(['transfer','credit_card_payment','balance_adjustments']);
  const SYSTEM_CARD_PAYMENT=new Set(['credit_card_payment']);
  const NAME_CARD_PAYMENT=/credit\s*card\s*payment|card\s*payment|payment\s*-\s*thank\s*you/i;
  const NAME_TRANSFER=/^transfer|transfer$|internal\s*transfer/i;
  const NAME_INVESTMENT=/invest|brokerage|contribution|401\s*\(?k\)?|roth|ira\b/i;

  const norm=s=>String(s==null?'':s).trim().toLowerCase();

  // A category as we need it: {id, name, groupType, systemCategory, isInvestment}
  function indexCategories(categories){
    const byId=new Map();
    for(const c of categories||[]){
      if(!c||c.id==null)continue;
      byId.set(String(c.id),{
        id:String(c.id),
        name:c.name||'',
        groupId:c.group&&c.group.id!=null?String(c.group.id):null,
        groupName:(c.group&&c.group.name)||'',
        groupType:norm(c.group&&c.group.type)||'',
        systemCategory:norm(c.systemCategory),
      });
    }
    return byId;
  }

  // Which bucket a single transaction falls in. `cats` is the Map from indexCategories.
  // Deliberately total: every transaction gets exactly one kind, so nothing is silently
  // dropped and the buckets always reconcile back to the raw ledger.
  function classify(txn,cats,opts){
    const o=opts||{};
    const cat=txn.categoryId!=null?(cats&&cats.get(String(txn.categoryId))):null;
    const name=norm(cat?cat.name:txn.categoryName);
    const sys=cat?cat.systemCategory:'';
    const group=cat?cat.groupType:'';

    // A user's own override wins over everything, including the provider's own taxonomy.
    if(txn.userKind&&Object.values(KIND).includes(txn.userKind))return txn.userKind;

    // Explicitly hidden, or a split parent we also hold the children for — counting both
    // would double the amount.
    if(txn.hideFromReports)return KIND.EXCLUDED;
    if(txn.isSplitTransaction&&o.hasSplitChildren!==false)return KIND.EXCLUDED;

    if(SYSTEM_CARD_PAYMENT.has(sys)||NAME_CARD_PAYMENT.test(name))return KIND.CARD_PAYMENT;

    // Investment moves read as transfers in Monarch, so check them first — otherwise every
    // brokerage contribution disappears into the transfer bucket and the cockpit can't tell
    // "we saved $4K" from "we shuffled $4K".
    const toInvestment=o.investmentAccountIds&&txn.accountId!=null&&o.investmentAccountIds.has(String(txn.accountId));
    if(toInvestment||NAME_INVESTMENT.test(name))return KIND.INVESTMENT;

    if(group==='transfer'||SYSTEM_TRANSFER.has(sys)||NAME_TRANSFER.test(name))return KIND.TRANSFER;
    if(group==='income')return KIND.INCOME;

    // Sign decides the last split. In Monarch an expense is negative, so a POSITIVE amount
    // sitting in an expense category is money coming back: a refund, return or reimbursement.
    // Treating it as income would overstate earnings and understate the category it belongs
    // to — it has to net against that category instead.
    if(txn.amount>0)return KIND.REFUND;
    return KIND.EXPENSE;
  }

  // ── Aggregation ──────────────────────────────────────────────────────────
  const monthKey=d=>String(d||'').slice(0,7);           // 'YYYY-MM'
  const spendOf=t=>-Number(t.amount||0);                 // expenses positive, refunds negative

  // Roll a classified ledger into per-month, per-category totals.
  //
  // Refunds net against their own category rather than forming a bucket of their own, which
  // is the only treatment that makes "spent on groceries" mean what a person means by it.
  // The gross figures are kept alongside so a large return is still visible rather than
  // silently cancelling an equally large purchase.
  function summarize(txns,categories,opts){
    const o=opts||{};
    const cats=indexCategories(categories);
    const months=new Map();
    const totals={expense:0,income:0,transfer:0,cardPayment:0,investment:0,refund:0,excluded:0};
    const counts={...totals};
    const flagged=[];

    for(const t of txns||[]){
      const kind=classify(t,cats,o);
      const amt=Number(t.amount||0);
      counts[kind]=(counts[kind]||0)+1;

      // Cash commitments include the full loan payment, but only the interest is consumption
      // — principal buys equity. Monarch does not split them, so the caller supplies a
      // per-account split and we mark anything unsplit for review rather than guessing.
      const mk=monthKey(t.date);
      if(!months.has(mk))months.set(mk,{month:mk,expense:0,income:0,transfer:0,cardPayment:0,
        investment:0,refund:0,byCategory:new Map(),count:0,pending:0,principal:0,interest:0});
      const m=months.get(mk);
      m.count++;
      if(t.pending)m.pending++;

      if(kind===KIND.EXCLUDED){totals.excluded+=Math.abs(amt);continue}

      if(kind===KIND.EXPENSE||kind===KIND.REFUND){
        const spend=spendOf(t); // negative for a refund, which is exactly the netting we want
        const cat=cats.get(String(t.categoryId));
        const key=cat?cat.id:'uncategorized';
        const label=cat?cat.name:(t.categoryName||'Uncategorized');
        if(!m.byCategory.has(key))m.byCategory.set(key,{id:key,name:label,net:0,gross:0,refunds:0,count:0});
        const c=m.byCategory.get(key);
        c.net+=spend;c.count++;
        if(spend>=0)c.gross+=spend;else c.refunds+=-spend;
        m.expense+=spend;
        totals.expense+=spend;
        if(kind===KIND.REFUND){m.refund+=-spend;totals.refund+=-spend}

        const split=o.loanSplits&&t.accountId!=null?o.loanSplits[String(t.accountId)]:null;
        if(split&&spend>0){
          // A supplied split is a ratio of interest within the payment.
          const interest=spend*Math.max(0,Math.min(1,split.interestShare));
          m.interest+=interest;m.principal+=spend-interest;
        }
      } else if(kind===KIND.INCOME){
        m.income+=amt;totals.income+=amt;
      } else if(kind===KIND.INVESTMENT){
        m.investment+=-amt;totals.investment+=-amt;
      } else if(kind===KIND.TRANSFER){
        m.transfer+=Math.abs(amt);totals.transfer+=Math.abs(amt);
      } else if(kind===KIND.CARD_PAYMENT){
        m.cardPayment+=Math.abs(amt);totals.cardPayment+=Math.abs(amt);
      }
    }

    const list=[...months.values()].sort((a,b)=>a.month<b.month?-1:1)
      .map(m=>({...m,categories:[...m.byCategory.values()].sort((a,b)=>b.net-a.net)}));
    return{months:list,totals,counts,flagged};
  }

  // ── Coverage ─────────────────────────────────────────────────────────────
  // Averages over a window that is only partly covered are worse than no average at all, so
  // every consumer asks this first rather than inferring completeness from row counts.
  function coverage(months,today){
    if(!months||!months.length)return{monthsCovered:0,first:null,last:null,completeMonths:[],partial:null};
    const now=today?new Date(today):new Date();
    const currentKey=now.toISOString().slice(0,7);
    const complete=months.filter(m=>m.month!==currentKey);
    return{
      monthsCovered:months.length,
      first:months[0].month,last:months[months.length-1].month,
      completeMonths:complete.map(m=>m.month),
      // The month in progress is never a data point — it is a fraction of one.
      partial:months.some(m=>m.month===currentKey)?currentKey:null,
      fractionElapsed:+(now.getDate()/new Date(now.getFullYear(),now.getMonth()+1,0).getDate()).toFixed(4),
    };
  }

  // Rolling average over COMPLETE months only, and only when the window is fully covered.
  // Returns null rather than a number computed from fewer months than asked for — a
  // "12-month average" built from 4 months is a misleading label, not a useful estimate.
  function rollingAverage(months,n,pick,today){
    const cov=coverage(months,today);
    const complete=months.filter(m=>m.month!==cov.partial);
    if(complete.length<n)return null;
    const window=complete.slice(-n);
    const f=pick||(m=>m.expense);
    return window.reduce((s,m)=>s+f(m),0)/n;
  }

  // ── Budgets ──────────────────────────────────────────────────────────────
  // Actual-vs-budget for one month. `budgets` is [{categoryId, planned}].
  function budgetStatus(month,budgets,opts){
    const o=opts||{};
    const byCat=new Map((month?month.categories:[]).map(c=>[c.id,c]));
    const rows=(budgets||[]).map(b=>{
      const c=byCat.get(String(b.categoryId));
      const actual=c?c.net:0;
      const planned=Number(b.planned||0);
      // Pro-rate the plan for a month still in progress, otherwise every category looks
      // under budget on the 3rd and the flags fire on the 28th.
      const expected=o.fractionElapsed!=null?planned*o.fractionElapsed:planned;
      return{categoryId:String(b.categoryId),name:(c&&c.name)||b.name||'—',
        planned,actual,expected,
        remaining:planned-actual,
        overBy:actual-expected,
        pctOfPlan:planned>0?actual/planned:null};
    });
    const uncategorized=(month?month.categories:[]).filter(c=>!rows.some(r=>r.categoryId===c.id));
    return{rows:rows.sort((a,b)=>b.overBy-a.overBy),unbudgeted:uncategorized,
      plannedTotal:rows.reduce((s,r)=>s+r.planned,0),
      actualTotal:rows.reduce((s,r)=>s+r.actual,0)+uncategorized.reduce((s,c)=>s+c.net,0)};
  }

  const api={KIND,indexCategories,classify,summarize,coverage,rollingAverage,budgetStatus,monthKey,spendOf};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerSpending=api;
})(typeof window!=='undefined'?window:this);
