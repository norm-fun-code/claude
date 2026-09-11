'use strict';
// ═══ ACCOUNT CLASSIFICATION, PROVENANCE & RECONCILIATION ═══
// Pure and shared by browser and Node, like model.js and spending.js.
//
// Three ideas the cockpit depends on, none of which the app had:
//
//  1. Classification is keyed on the STABLE ACCOUNT ID, not the display name. Renaming an
//     account in Monarch must not silently reclassify a chunk of net worth, and a name-based
//     rule that reads "Stripe" cannot tell a Stripe 401(k) from Stripe company stock — one
//     is diversified retirement money, the other is concentrated private equity in the same
//     employer. Conflating them overstates concentration risk in one direction or hides it
//     in the other.
//
//  2. Every figure carries provenance: what it is, where it came from, and when. An observed
//     balance, a fact the user typed, and a model projection are three different kinds of
//     claim, and a cockpit that renders them identically is misleading even when every
//     number is right.
//
//  3. Missing is not zero. A balance the provider failed to return is unknown, and the only
//     thing that may turn it into a number is an explicit, dated, per-account confirmation
//     from the user — never a default, never a blanket rule.

(function(root){

  // ── Classes ──────────────────────────────────────────────────────────────
  const CLASS={
    CASH:'cash',            // spendable today
    TAXABLE:'taxable',      // brokerage — sellable, with tax consequences
    RETIREMENT:'retirement',// locked until retirement age
    PRIVATE:'private',      // illiquid private holdings, e.g. vested Stripe equity
    DEBT:'debt',            // liabilities
    UNKNOWN:'unknown',      // deliberately explicit rather than defaulted
  };
  // What can actually be spent or pledged in the near term. Retirement and private holdings
  // are wealth but not access, and treating them as access is how a plan looks solvent right
  // up until the money is needed.
  const ACCESSIBLE=new Set([CLASS.CASH,CLASS.TAXABLE]);

  const SOURCE={PROVIDER:'provider',USER:'user',MODEL:'model'};

  // ── Hiding ───────────────────────────────────────────────────────────────
  // Hiding is a FLAG, not a class. What an account IS and whether you want to look at it
  // are different questions: a closed 2014 savings account is still cash. Folding hiding
  // into the class would throw away the classification the moment it is hidden, and would
  // make "hidden" compete with "unknown" in rules that have nothing to do with it.
  //
  // The rule that matters: hiding is only cosmetic when the balance is ZERO. Hide an
  // account that still holds something and net worth falls, so every total below reports
  // what was excluded rather than quietly shrinking.
  function isHidden(account,overrides){
    const id=account&&account.id!=null?String(account.id):null;
    const ov=id&&overrides?overrides[id]:null;
    return !!(ov&&ov.hidden);
  }

  const norm=s=>String(s==null?'':s).trim().toLowerCase();

  // ── Classification ───────────────────────────────────────────────────────
  // Order matters: a user's explicit assignment always wins, then rules that read the
  // provider's own type, then name heuristics, and only then unknown. Nothing is guessed
  // into a class silently — an unrecognised account says so.
  const RETIREMENT_HINT=/\b401\s*\(?k\)?|\b403\s*\(?b\)?|\b457\b|\bira\b|roth|pension|retirement|rrsp|hsa\b/i;
  const DEBT_HINT=/credit\s*card|loan|mortgage|\bheloc\b|line\s*of\s*credit|\bploc\b|liabilit/i;
  const CASH_HINT=/checking|savings|money\s*market|\bcash\b|deposit/i;
  const BROKERAGE_HINT=/brokerage|taxable|invest|individual|joint\s*account/i;
  const PRIVATE_HINT=/equity|\brsu\b|private|pre-?ipo|shares|stock\s*plan|carta|vested/i;

  // Provider category → class, where the provider actually tells us.
  const PROVIDER_CLASS={
    cash:CLASS.CASH, depository:CLASS.CASH,
    investment:CLASS.TAXABLE, brokerage:CLASS.TAXABLE,
    retirement:CLASS.RETIREMENT,
    loan:CLASS.DEBT, credit:CLASS.DEBT, liability:CLASS.DEBT,
    other_asset:CLASS.UNKNOWN, other:CLASS.UNKNOWN, real_estate:CLASS.PRIVATE,
  };

  function classifyAccount(account,overrides){
    const id=account&&account.id!=null?String(account.id):null;
    const name=norm(account&&account.name);
    const inst=norm(account&&account.institution);
    const cat=norm(account&&account.category);
    const sub=norm(account&&account.subtype);
    const hay=`${name} ${inst} ${sub}`;

    const ov=id&&overrides?overrides[id]:null;
    if(ov&&ov.class)return{cls:ov.class,source:SOURCE.USER,reason:ov.note||'set by you',
      stripeKind:ov.stripeKind||null};

    // Retirement is checked FIRST and deliberately beats every Stripe rule below. A Stripe
    // 401(k) is retirement money that merely happens to sit at the same employer; calling it
    // Stripe company stock would double the apparent concentration and be simply wrong.
    if(RETIREMENT_HINT.test(hay)||PROVIDER_CLASS[cat]===CLASS.RETIREMENT){
      return{cls:CLASS.RETIREMENT,source:SOURCE.PROVIDER,
        reason:/stripe/.test(hay)?'retirement plan at Stripe — not company stock':'retirement account',
        stripeKind:null};
    }
    if(DEBT_HINT.test(hay)||PROVIDER_CLASS[cat]===CLASS.DEBT||(Number(account&&account.balance)<0&&cat==='liability')){
      return{cls:CLASS.DEBT,source:SOURCE.PROVIDER,reason:'liability',stripeKind:null};
    }
    // Vested company equity. Only reached once retirement has been ruled out.
    if(/stripe/.test(hay)&&(PRIVATE_HINT.test(hay)||cat==='investment'||cat==='other_asset')){
      return{cls:CLASS.PRIVATE,source:SOURCE.PROVIDER,
        reason:'vested Stripe equity — private, illiquid',stripeKind:'vested'};
    }
    if(CASH_HINT.test(hay))return{cls:CLASS.CASH,source:SOURCE.PROVIDER,reason:'cash account',stripeKind:null};
    if(BROKERAGE_HINT.test(hay))return{cls:CLASS.TAXABLE,source:SOURCE.PROVIDER,reason:'taxable brokerage',stripeKind:null};
    if(PRIVATE_HINT.test(hay))return{cls:CLASS.PRIVATE,source:SOURCE.PROVIDER,reason:'private holding',stripeKind:null};
    const byCat=PROVIDER_CLASS[cat];
    if(byCat&&byCat!==CLASS.UNKNOWN)return{cls:byCat,source:SOURCE.PROVIDER,reason:`provider category "${cat}"`,stripeKind:null};
    return{cls:CLASS.UNKNOWN,source:SOURCE.PROVIDER,reason:'unrecognised — classify it to include it',stripeKind:null};
  }

  // ── Balance provenance ───────────────────────────────────────────────────
  // Resolve one account's balance into a value plus the story of where it came from.
  // A provider balance always wins over an override, because a real observation supersedes
  // a user's standing confirmation the moment one arrives.
  function resolveBalance(account,overrides){
    const id=account&&account.id!=null?String(account.id):null;
    const ov=id&&overrides?overrides[id]:null;
    const raw=account?account.rawBalance:undefined;
    const has=account&&typeof account.balance==='number'&&isFinite(account.balance);

    if(has){
      const superseded=!!(ov&&ov.balance!=null);
      return{value:account.balance,source:SOURCE.PROVIDER,asOf:account.asOf||null,
        missing:false,supersededOverride:superseded,
        note:superseded?'a live balance arrived, so your confirmed value is no longer used':null};
    }
    if(ov&&ov.balance!=null){
      return{value:Number(ov.balance),source:SOURCE.USER,asOf:ov.confirmedAt||null,missing:false,
        // The provider's failure is preserved rather than erased: the number is the user's,
        // and the record still shows that Monarch returned nothing.
        rawMissing:raw===undefined?null:raw,
        note:ov.note||'confirmed by you because the provider returned no balance'};
    }
    return{value:null,source:null,asOf:null,missing:true,rawMissing:raw===undefined?null:raw,
      note:'the provider returned no balance and you have not confirmed one'};
  }

  // ── Roll-up ──────────────────────────────────────────────────────────────
  // Accounts whose balance is unknown are counted nowhere and listed separately, so a total
  // is never quietly short by an unknown amount.
  function summarize(accounts,overrides){
    const byClass={};for(const k of Object.values(CLASS))byClass[k]={total:0,accounts:[]};
    const unknownBalance=[],hidden=[];
    let assets=0,debt=0,accessible=0,stripeVested=0;
    // What hiding actually costs, tracked separately so it can be reported rather than
    // absorbed. hiddenUnknown counts accounts that were hidden while their balance was
    // still unknown — hiding removed them from the "missing balances" list, and that is a
    // decision the reader made, not a gap that got resolved.
    let hiddenAssets=0,hiddenDebt=0,hiddenUnknown=0;
    for(const a of accounts||[]){
      const c=classifyAccount(a,overrides);
      const b=resolveBalance(a,overrides);
      const row={...a,cls:c.cls,clsSource:c.source,clsReason:c.reason,stripeKind:c.stripeKind,
        balance:b.value,balanceSource:b.source,balanceAsOf:b.asOf,balanceMissing:b.missing,
        balanceNote:b.note,rawMissing:b.rawMissing,supersededOverride:b.supersededOverride,
        hidden:isHidden(a,overrides)};

      if(row.hidden){
        hidden.push(row);
        if(b.missing)hiddenUnknown++;
        else if(c.cls===CLASS.DEBT)hiddenDebt+=Math.abs(b.value);
        else hiddenAssets+=b.value;
        continue;                       // hidden accounts touch no total and no class list
      }

      byClass[c.cls].accounts.push(row);
      if(b.missing){unknownBalance.push(row);continue}
      byClass[c.cls].total+=b.value;
      if(c.cls===CLASS.DEBT)debt+=Math.abs(b.value);
      else{
        assets+=b.value;
        if(ACCESSIBLE.has(c.cls))accessible+=b.value;
        if(c.stripeKind==='vested')stripeVested+=b.value;
      }
    }
    const hiddenNet=hiddenAssets-hiddenDebt;
    return{byClass,assets,debt,netWorth:assets-debt,accessible,stripeVested,
      unknownBalance,complete:unknownBalance.length===0,
      hidden,hiddenCount:hidden.length,hiddenAssets,hiddenDebt,hiddenNet,hiddenUnknown,
      // The distinction the UI needs to tell the truth in one line. Hiding closed accounts
      // is free; hiding a funded one is a change to the figure everything else is built on.
      hiddenIsCosmetic:hidden.length>0&&hiddenNet===0&&hiddenUnknown===0,
      hiddenNote:!hidden.length?null
        :hiddenNet===0&&hiddenUnknown===0
          ?`${hidden.length} hidden account${hidden.length===1?'':'s'}, all at zero — totals are unchanged.`
          :hiddenUnknown>0&&hiddenNet===0
            ?`${hidden.length} hidden, ${hiddenUnknown} of which had no balance from the provider. Those are no longer counted as missing.`
            :`${hidden.length} hidden, holding ${hiddenNet<0?'−':''}$${Math.abs(Math.round(hiddenNet)).toLocaleString('en-US')} that is NOT in the totals above.`};
  }

  // ── Reconciliation with the plan ─────────────────────────────────────────
  // Proposes, never applies. Each line says what the plan assumes, what the accounts
  // observe, and what it would take to agree — the user decides whether the plan is wrong or
  // the world is.
  function reconcile(summary,P){
    const lines=[];
    const push=(key,label,planValue,actual,note,backing)=>{
      // An actual of zero means two very different things. If accounts ARE classified into
      // this bucket and they total zero, that is an observation. If NOTHING is classified
      // into it, the zero is an absence of evidence — and applying it would wipe a real plan
      // value on the strength of a classification gap. The two must not look alike.
      const unbacked=actual===0&&planValue!==0&&backing===0;
      lines.push({
        key,label,planValue,actual,delta:actual-planValue,note,
        accountsBacking:backing,applicable:!unbacked,
        blockedReason:unbacked?'No account is classified into this bucket, so this zero is a gap in classification rather than an observed balance. Classify the right account first — applying now would erase your plan value.':null,
        planSource:SOURCE.MODEL,actualSource:SOURCE.PROVIDER});
    };

    // The diversified pool in the plan excludes Stripe by construction, so the comparable
    // observed figure is accessible assets MINUS anything classified as vested Stripe.
    const accessibleExStripe=summary.accessible;
    const nAccessible=summary.byClass[CLASS.CASH].accounts.length+summary.byClass[CLASS.TAXABLE].accounts.length;
    const nStripe=Object.values(summary.byClass).reduce((n,g)=>n+g.accounts.filter(a=>a.stripeKind==='vested').length,0);
    push('startingLiquid','Diversified liquid',Number(P.startingLiquid||0),accessibleExStripe,
      'cash + taxable brokerage, excluding Stripe and retirement',nAccessible);
    push('startingStripeEquity','Stripe equity',Number(P.startingStripeEquity||0),summary.stripeVested,
      'vested Stripe holdings only — unvested grants are future compensation, not an asset',nStripe);
    push('k401Start','Retirement',Number(P.k401Start||0),summary.byClass[CLASS.RETIREMENT].total,
      'includes any Stripe 401(k), which is retirement money rather than company stock',
      summary.byClass[CLASS.RETIREMENT].accounts.length);
    // Gross assets cannot replace the opening position while liabilities are omitted.
    if(summary.debt>0||!summary.complete)for(const line of lines){
      line.applicable=false;
      line.blockedReason=summary.debt>0?'Existing liabilities need an explicit repayment plan before balances can be applied. Gross assets alone would overstate the plan.':'Resolve missing balances before applying account totals.';
    }
    return{lines,complete:summary.complete,
      blocked:summary.unknownBalance.map(a=>a.name||a.id)};
  }

  // ── Double counting ──────────────────────────────────────────────────────
  // Holdings live INSIDE an account balance. Adding both is the classic error, and it is
  // silent: the total simply looks better. This finds the overlap rather than trusting that
  // whoever wired the view remembered.
  function detectDoubleCounting(accounts,holdings){
    const issues=[];
    const held=(holdings||[]).reduce((s,h)=>s+(Number(h.value)||0),0);
    if(!held)return issues;
    for(const a of accounts||[]){
      const bal=Number(a.balance);
      if(!isFinite(bal)||bal<=0)continue;
      // A holdings total that matches an account balance closely is that account's contents,
      // not additional wealth.
      if(Math.abs(bal-held)/Math.max(bal,held)<0.02){
        issues.push({accountId:a.id!=null?String(a.id):null,name:a.name||'',
          balance:bal,holdingsTotal:held,
          message:'These holdings appear to BE this account’s balance. Count one or the other, not both.'});
      }
    }
    return issues;
  }

  // ── Capabilities ─────────────────────────────────────────────────────────
  // Tracked per data type, because they genuinely differ: balances arrive through a bridge,
  // holdings and transactions through a direct token, and tax lots are not exposed at all.
  // Anything that reads a capability must disable only the analysis that depends on it.
  function capabilities(state){
    const s=state||{};
    const mk=(available,detail,asOf)=>({available:!!available,detail,asOf:asOf||null});
    return{
      balances:mk(s.balances!=null?s.balances:false,
        s.balancesDetail||'account balances from Monarch',s.balancesAsOf),
      holdings:mk(s.holdings,s.holdingsDetail||'per-position values and cost basis',s.holdingsAsOf),
      transactions:mk(s.transactions,s.transactionsDetail||'transaction history for spending analysis',s.transactionsAsOf),
      // Not a failure to be retried: Monarch's connector does not expose tax lots at all, so
      // anything promising lot-level tax analysis is overclaiming.
      taxLots:mk(false,'not exposed by Monarch — lot-level gain/loss analysis is unavailable',null),
    };
  }
  // What a missing capability actually costs, so the UI disables features rather than the
  // whole view.
  function blockedBy(caps){
    const out=[];
    if(!caps.holdings.available)out.push({feature:'Allocation & concentration by position',needs:'holdings'});
    if(!caps.transactions.available)out.push({feature:'Spending, budgets and cash-flow history',needs:'transactions'});
    if(!caps.taxLots.available)out.push({feature:'Tax-lot level gain/loss and harvesting',needs:'taxLots'});
    return out;
  }

  const api={CLASS,SOURCE,ACCESSIBLE,classifyAccount,resolveBalance,isHidden,summarize,reconcile,
    detectDoubleCounting,capabilities,blockedBy};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerAccounts=api;
})(typeof window!=='undefined'?window:this);
