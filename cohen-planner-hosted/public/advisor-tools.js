'use strict';
// ═══ ADVISOR TOOLS — WHAT THE MODEL IS ALLOWED TO DO ═══
// Pure, shared by the server and the tests. Schemas and executors live together so the
// thing the model is told it can do and the thing it can actually do cannot drift apart.
//
// The division of labour this file enforces:
//
//   THE MODEL DECIDES WHAT TO ASK. It picks which scenario to run, which alternatives are
//   worth comparing, which rule is relevant, and how to explain the answer.
//
//   THE MODEL NEVER COMPUTES. Every number comes back from the same engine the app uses.
//   Arithmetic done in a model's head is unreviewable and wrong often enough to matter when
//   the subject is someone's mortgage.
//
//   THE MODEL NEVER WRITES. propose_changes and record_decision stage something for review
//   and return it. Nothing they produce touches the plan until a person accepts it.
//
// Validation is strict on purpose. An unknown parameter key returns an ERROR naming the
// valid keys rather than being ignored — silently dropping it would let the advisor report
// a scenario it never actually ran.

(function(root,deps){
  const {model,taxRules,monitors,taxPlan}=deps||{};

  const usd=v=>(v<0?'−':'')+'$'+Math.round(Math.abs(v)).toLocaleString('en-US');

  // ── What may be changed, and within what bounds ──────────────────────────
  // Bounds are sanity rails, not opinions: they catch a decimal-point slip or a percentage
  // entered as 6 instead of 0.06, which would otherwise produce a confident, absurd answer.
  const LIMITS={
    homePrice:[0,5e7],downPctg:[0,100],mortgageRate:[0,25],homePurchaseYear:[2020,2100],
    homeAppreciation:[-0.5,0.5],propTaxRate:[0,0.1],
    investReturn:[-0.5,0.5],expenseInflation:[-0.2,0.5],tuitionInflation:[-0.2,0.5],
    taxInflation:[-0.2,0.2],capGainsTaxRate:[0,0.7],costBasisPct:[0,1],
    startingLiquid:[-1e8,1e8],startingStripeEquity:[0,1e9],k401Start:[0,1e8],
    liquidReserveFloor:[0,1e8],stripeSellPct:[0,1],stripeLongTermReturn:[-0.9,2],
    stripeVestWithholdingRate:[0,0.9],stripeObservedMonth:[1,12],
    concentrationThreshold:[0,1],
    pretax401k:[0,1e6],pretaxBenefits:[0,1e6],
    nycRent:[0,1e6],baseGroceries:[0,1e6],baseDining:[0,1e6],baseShopping:[0,1e6],
    baseVacations:[0,1e6],postKidVacations:[0,1e6],baseMisc:[0,1e6],baseCharity:[0,1e7],
    baseMedical:[0,1e6],childcareMonthly:[0,1e5],
    numKids:[0,12],yeshivaStartAge:[0,22],kid1YeshivaStartAge:[0,22],
    // WHEN each child arrives, not only how many. numKids alone could add a child without
    // being able to say what year — and the year is what drives childcare and tuition.
    kid1Birth:[1950,2100],kid2Birth:[1950,2100],kid3Birth:[1950,2100],kid4Birth:[1950,2100],
    nancyHourlyRate:[0,2000],nancyMaxClients:[0,100],nancyRampClients:[0,100],
    nancyRampYears:[0,40],nancyWeeksPerYear:[0,52],nancyPracticeOverhead:[0,1e6],
    normGrowth:[-0.5,1],normStockGrowth:[-0.5,2],
  };
  const ENUMS={
    stripePolicy:['deficit','floor','pct','retain','sell'],
  };
  // Per-year comp and return inputs, addressed by index.
  const INDEXED=[
    {prefix:'normCashY',max:10,range:[0,1e8]},
    // A one-off for a single year — a baby's first year, a wedding, a renovation. Signed:
    // negative is a year that costs less. See expenseAdjFor in model.js for why it is
    // neither inflated nor scaled.
    {prefix:'expenseAdjY',max:10,range:[-1e7,1e7]},
    {prefix:'normStockY',max:10,range:[0,1e8]},
    {prefix:'stripeRetY',max:9,range:[-0.9,3]},
    {prefix:'nancyW2Y',max:3,range:[0,1e7]},
  ];

  function validateOverride(key,value){
    if(ENUMS[key]){
      if(!ENUMS[key].includes(value))
        return{ok:false,error:`"${key}" must be one of: ${ENUMS[key].join(', ')}. Got ${JSON.stringify(value)}.`};
      return{ok:true,value};
    }
    let range=LIMITS[key];
    if(!range){
      const ix=INDEXED.find(g=>new RegExp(`^${g.prefix}(\\d+)$`).test(key));
      if(ix){
        const i=Number(key.slice(ix.prefix.length));
        if(i>ix.max)return{ok:false,error:`"${key}" is out of range — ${ix.prefix} goes up to ${ix.prefix}${ix.max}.`};
        range=ix.range;
      }
    }
    if(!range)return{ok:false,error:`"${key}" is not a parameter this plan has. Valid keys: ${knownKeys().join(', ')}.`};
    const n=Number(value);
    if(!Number.isFinite(n))return{ok:false,error:`"${key}" needs a number. Got ${JSON.stringify(value)}.`};
    if(n<range[0]||n>range[1])
      return{ok:false,error:`"${key}" = ${n} is outside the plausible range ${range[0]} to ${range[1]}. `+
        `Rates are decimals (0.06, not 6) and percentages of a price are whole numbers (20 for 20%).`};
    return{ok:true,value:n};
  }

  function knownKeys(){
    return[...Object.keys(LIMITS),...Object.keys(ENUMS),
      ...INDEXED.map(g=>`${g.prefix}0…${g.prefix}${g.max}`)].sort();
  }

  function applyOverrides(P,overrides){
    const errors=[],applied={};
    const next={...P};
    for(const[key,value]of Object.entries(overrides||{})){
      if(P.stripeGrants?.enabled&&/^normCashY\d+$/.test(key)&&(P.planStartYear||2026)+Number(key.slice(9))>(P.stripeGrants.throughYear??Infinity)){errors.push('This year uses manual total compensation. Edit it in Stripe → Compensation.');continue;}
      if(P.stripeGrants?.enabled&&(/^normStockY/.test(key)||key==='normStockGrowth')){errors.push('Stock income is calculated from Stripe grants. Edit award dollars or actual schedules in the Stripe tab.');continue;}
      const v=validateOverride(key,value);
      if(!v.ok){errors.push(v.error);continue}
      // A change that changes nothing is worth saying out loud — otherwise the advisor
      // reports a "what-if" whose numbers are identical and reads as a broken model.
      if(next[key]===v.value)applied[key]={from:P[key],to:v.value,noop:true};
      else applied[key]={from:P[key],to:v.value};
      next[key]=v.value;
    }
    return{params:next,applied,errors};
  }

  // ── Metrics the advisor may ask for ─────────────────────────────────────
  // A fixed vocabulary rather than free-form field access, so every answer is a figure the
  // app itself reports and can be checked against the same screen the user is looking at.
  const METRICS={
    finalNetWorth:{label:'Net worth at plan end',pick:r=>r.R[r.R.length-1].netWorth,fmt:usd},
    final401k:{label:'401(k) at plan end',pick:r=>r.R[r.R.length-1].k401,fmt:usd},
    liquidFloor:{label:'Lowest projected liquid assets',pick:r=>Math.min(...r.R.map(x=>x.liq)),fmt:usd},
    liquidFloorYear:{label:'Year of the liquid low point',
      pick:r=>r.R.reduce((a,b)=>b.liq<a.liq?b:a).yr,fmt:String},
    drawYears:{label:'Years drawing on savings or held Stripe',pick:r=>r.drawYears,fmt:n=>`${n} yrs`},
    worstNetFlow:{label:'Worst year net flow',pick:r=>Math.min(...r.R.map(x=>x.flow)),fmt:usd},
    negativeFlowYears:{label:'Years with negative net flow',
      pick:r=>r.R.filter(x=>x.flow<0).length,fmt:n=>`${n} yrs`},
    firstYearNetFlow:{label:'Net flow, first year',pick:r=>r.R[0].flow,fmt:usd},
    totalTax:{label:'Cumulative tax over the plan',pick:r=>r.R.reduce((s,x)=>s+x.tax,0),fmt:usd},
    totalTuition:{label:'Cumulative tuition',pick:r=>r.tT,fmt:usd},
    taxOnStockSales:{label:'Tax on portfolio sales',pick:r=>r.tTx,fmt:usd},
    stripeShareEnd:{label:'Stripe share of net worth at plan end',
      pick:r=>r.R[r.R.length-1].sPct,fmt:v=>(v*100).toFixed(1)+'%'},
    peakStripeShare:{label:'Peak Stripe share of net worth',
      pick:r=>Math.max(...r.R.map(x=>x.sPct)),fmt:v=>(v*100).toFixed(1)+'%'},
    monthlyMortgage:{label:'Mortgage payment per month',pick:r=>r.mm,fmt:usd},
    downPayment:{label:'Down payment',pick:r=>r.dp,fmt:usd},
  };
  const DEFAULT_METRICS=['finalNetWorth','liquidFloor','liquidFloorYear','drawYears','worstNetFlow'];

  function measure(results,names){
    const out={};
    const unknown=[];
    for(const name of names&&names.length?names:DEFAULT_METRICS){
      const m=METRICS[name];
      if(!m){unknown.push(name);continue}
      const value=m.pick(results);
      out[name]={label:m.label,value,display:m.fmt(value)};
    }
    return{metrics:out,unknownMetrics:unknown,
      availableMetrics:unknown.length?Object.keys(METRICS):undefined};
  }

  // ── get_projection ──────────────────────────────────────────────────────
  // METRICS is a fixed vocabulary of headline figures, which is right for "what happens if"
  // but useless for "how does 2027 reach $220K" — the advisor could quote the total and not
  // one thing inside it, so it said it could see the total but not the categories. This
  // returns the YEARS themselves, each with its expense composition, straight off the same
  // rows the projection table draws. Nothing is recomputed here and nothing is inferred; a
  // breakdown the model added up itself would be exactly the unreviewable arithmetic the
  // rest of this file exists to prevent.
  function getProjection({P,overrides,from,to}){
    if(!model||typeof model.run!=='function')
      return{error:'The projection engine is unavailable, so no figure can be produced.'};
    const{params,applied,errors}=applyOverrides(P,overrides);
    if(errors.length)return{error:errors.join(' '),applied:null};
    let results;
    try{results=model.run(params)}
    catch(err){return{error:`The projection failed with these inputs: ${err.message}`}}
    if(!results||!results.R||!results.R.length)return{error:'These inputs produce no projection years.'};
    const lo=Number.isFinite(Number(from))?Number(from):-Infinity;
    const hi=Number.isFinite(Number(to))?Number(to):Infinity;
    const rows=results.R.filter(r=>r.yr>=lo&&r.yr<=hi);
    if(!rows.length)return{error:`The plan covers ${results.R[0].yr}–${results.R[results.R.length-1].yr}; that range holds no years.`};
    return{
      applied:Object.keys(applied||{}).length?applied:undefined,
      planYears:`${results.R[0].yr}–${results.R[results.R.length-1].yr}`,
      years:rows.map(r=>({
        year:r.yr,
        // Below 1 this year is a STUB: the plan opened partway through it, so these figures
        // cover only the months after that date. Say so before comparing it with a full year.
        fractionOfYearModelled:r.stubFrac,
        income:{gross:r.gross,tax:r.tax,effectiveRate:r.effRate,
          cashAvailable:r.inc,normCash:r.normCash,normStock:r.normStock,nancyGross:r.nancyG},
        // The four components and the one-off, which SUM to total — exactly, because the
        // engine sums the rounded parts rather than rounding the raw sum.
        expenses:{housing:r.h,living:r.liv,
          // Living is twelve lines and it is usually the largest of the four. Handing over
          // only its sum is the same defect one level down: a total nobody can see inside.
          livingBreakdown:r.livParts||undefined,
          childcare:r.cc,tuition:r.tu,
          oneOffAdjustment:r.eAdj||0,total:r.totE,
          fullYearTotal:r.totEFull,
          kidsInSchool:r.kiy,propertyTaxWithinHousing:r.ptax},
        netFlow:r.flow,cashGap:r.gap,incomeGap:r.incGap,
        balances:{liquidExStripe:r.liq,stripeEquity:r.sEnd,homeEquity:r.eq,
          retirement:r.k401,netWorth:r.netWorth,netWorthExRetirement:r.nw},
        stripe:{soldForCash:r.sSold,retained:r.sRet,shareOfNetWorth:r.sPct},
      })),
      notes:{
        expenses:'housing + living + childcare + tuition + oneOffAdjustment = total, exactly, and livingBreakdown sums to living the same way. Housing is rent, or mortgage + property tax + insurance + maintenance once the home is bought. Living is opened out in livingBreakdown — groceries, dining, shopping, vacations, auto, insurance, misc, entertainment, charity, medical, transit and utilities — each already including that year\'s share for every child.',
        oneOffAdjustment:'A signed dollar amount for that single year (expenseAdjY0…Y10), for a one-time cost like a baby\'s first year or a renovation. It is not inflated and not spread across the year.',
        fullYearTotal:'What the whole calendar year costs. It differs from total only in a stub year, where total covers just the months the plan models.',
        cashGap:'Shortfall against CASH pay alone — how much of that year\'s vest must be sold. Closing it consumes no accumulated wealth. Never call it a deficit.',
        incomeGap:'What is still short after selling every vesting share. THIS is the figure that draws on savings or held Stripe.',
      },
    };
  }

  // ── compute ─────────────────────────────────────────────────────────────
  function compute({P,overrides,metrics}){
    if(!model||typeof model.run!=='function')
      return{error:'The projection engine is unavailable, so no figure can be produced.'};
    const{params,applied,errors}=applyOverrides(P,overrides);
    // Refuse the whole call rather than running a scenario that silently omits one of the
    // changes the advisor thinks it made.
    if(errors.length)return{error:errors.join(' '),applied:null};
    let results;
    try{results=model.run(params)}
    catch(err){return{error:`The projection failed with these inputs: ${err.message}`}}
    // A run that produced no years cannot answer anything. Every metric below would read off
    // an empty array and either throw or, worse, quietly return undefined.
    if(!results||!results.R||!results.R.length)
      return{error:`These inputs produce no projection years. Check that planEndYear (${params.planEndYear}) is after planStartYear (${params.planStartYear}).`};
    let m;
    try{m=measure(results,metrics)}
    catch(err){return{error:`A metric could not be read from this projection: ${err.message}`}}
    return{
      applied,
      ...m,
      // Assumptions that drive the answer, stated with the answer rather than on request.
      assumptions:{
        portfolioReturn:params.investReturn,
        expenseInflation:params.expenseInflation,
        stripeReturnFirstYear:results.R[0]?results.R[0].sRate:null,
        stripePolicy:params.stripePolicy||'deficit',
        liquidReserveFloor:params.liquidReserveFloor,
        vestWithholdingRate:results.R[0]?results.R[0].sVestRate:null,
        stateBracketsIndexed:!!params.indexStateBrackets,
        planYears:`${results.R[0].yr}–${results.R[results.R.length-1].yr}`,
      },
      note:'Figures come from the same engine the app displays. They are projections under the assumptions listed, not forecasts.',
    };
  }

  // ── compare_alternatives ────────────────────────────────────────────────
  // Runs each alternative against the SAME baseline and reports the differences, including
  // which assumptions differ between them — the part a reader needs to judge the comparison
  // and the part most likely to be left out.
  function compareAlternatives({P,alternatives,metrics}){
    if(!Array.isArray(alternatives)||alternatives.length<2)
      return{error:'A comparison needs at least two alternatives. To measure one change against the current plan, include the current plan as an alternative with no overrides.'};
    if(alternatives.length>6)
      return{error:'Compare at most six alternatives at once; beyond that the table stops being readable.'};
    const rows=[],errors=[];
    for(const alt of alternatives){
      if(!alt||!alt.name){errors.push('Every alternative needs a name.');continue}
      const r=compute({P,overrides:alt.overrides,metrics});
      if(r.error){errors.push(`${alt.name}: ${r.error}`);continue}
      rows.push({name:alt.name,changes:r.applied,metrics:r.metrics,assumptions:r.assumptions});
    }
    if(errors.length)return{error:errors.join(' ')};

    const names=Object.keys(rows[0].metrics);
    const comparison=names.map(key=>{
      const values=rows.map(r=>({name:r.name,value:r.metrics[key].value,display:r.metrics[key].display}));
      const numeric=values.every(v=>typeof v.value==='number');
      return{metric:key,label:rows[0].metrics[key].label,values,
        spread:numeric?Math.max(...values.map(v=>v.value))-Math.min(...values.map(v=>v.value)):null};
    // Biggest difference first: the metric the alternatives actually disagree about is the
    // one the decision turns on.
    }).sort((a,b)=>(b.spread??-1)-(a.spread??-1));

    // Assumptions that are NOT the same across alternatives. A comparison where these differ
    // is not comparing like with like, and the reader has to be told which.
    const differing=[];
    for(const key of Object.keys(rows[0].assumptions)){
      const vals=new Set(rows.map(r=>JSON.stringify(r.assumptions[key])));
      if(vals.size>1)differing.push({assumption:key,
        values:rows.map(r=>({name:r.name,value:r.assumptions[key]}))});
    }
    return{alternatives:rows,comparison,differingAssumptions:differing,
      sharedAssumptions:rows[0].assumptions,
      note:differing.length
        ?'These alternatives do not share every assumption — the differences are listed, and they are part of the result rather than noise around it.'
        :'Every alternative uses the same assumptions, so the differences are due only to the changes listed.'};
  }

  // ── lookup_tax_rule ─────────────────────────────────────────────────────
  // Always returns the year, the jurisdiction, the source and when it was read. A rule
  // quoted without those is a recollection, and this file will not produce one.
  function lookupTaxRule({ruleId,today}){
    if(!taxRules)return{error:'The tax rule table is unavailable.'};
    if(!ruleId||!taxRules.RULES[ruleId])
      return{error:`No such rule. Available: ${Object.keys(taxRules.RULES).join(', ')}.`};
    const r=taxRules.rule(ruleId);
    const stale=taxRules.staleness(today);
    return{
      rule:ruleId,label:r.label,value:r.value,
      taxYear:r.year,jurisdiction:r.jurisdiction,filingStatus:r.filingStatus||null,
      indexedForInflation:r.indexed,
      source:{publisher:r.sourceRef.publisher,title:r.sourceRef.title,url:r.sourceRef.url,
        citation:r.citation,retrieved:r.sourceRef.retrieved},
      citation:taxRules.cite(ruleId),
      staleness:stale,
      // The caveat travels with the figure rather than being left to the model's discretion.
      caveat:stale.coversCurrentYear
        ?`This is the ${r.year} figure for ${r.jurisdiction}, read from the primary source on ${r.sourceRef.retrieved}. Say the year and jurisdiction when you quote it.`
        :`WARNING: this is the ${r.year} figure and planning has moved past that year. Do not present it as current law — say it needs re-reading from ${r.sourceRef.url}.`,
    };
  }

  // ── propose_changes ─────────────────────────────────────────────────────
  // Stages a change set. Returns it for review; writes nothing, ever.
  function proposeChanges({P,overrides,rationale,metrics}){
    if(!rationale)return{error:'A proposal needs a rationale — what it is meant to achieve and why.'};
    const preview=compute({P,overrides,metrics});
    if(preview.error)return{error:preview.error};
    const baseline=compute({P,overrides:{},metrics});
    const deltas={};
    for(const[key,m]of Object.entries(preview.metrics)){
      const b=baseline.metrics[key];
      deltas[key]={label:m.label,from:b.display,to:m.display,
        delta:typeof m.value==='number'&&typeof b.value==='number'?m.value-b.value:null};
    }
    const noops=Object.entries(preview.applied).filter(([,v])=>v.noop).map(([k])=>k);
    return{
      status:'proposed',
      applied:preview.applied,
      rationale,
      impact:deltas,
      assumptions:preview.assumptions,
      noops:noops.length?noops:undefined,
      warning:noops.length
        ?`${noops.join(', ')} already had the proposed value, so the change is smaller than it appears.`
        :null,
      note:'NOTHING HAS BEEN CHANGED. This is a proposal for review. The user applies it to their plan, to a new scenario, or not at all.',
    };
  }

  // ── record_decision ─────────────────────────────────────────────────────
  // Also staged. The validation here is what makes a decision reviewable later: without a
  // rationale it can only be second-guessed, and without a resolvable trigger it can never
  // be re-opened by anything except someone happening to remember it.
  function recordDecision(d,opts){
    const o=opts||{};
    const errors=[];
    if(!d||!d.title)errors.push('A decision needs a title.');
    if(!d||!d.rationale)errors.push('A decision needs its rationale. Without the reasoning it cannot be reviewed later, only second-guessed.');
    const conds=(d&&d.reconsiderWhen)||[];
    for(const c of conds){
      if(!monitors||!monitors.METRICS[c.metric])
        errors.push(`"${c.metric}" is not something the monitors can measure, so this condition would never fire. Measurable: ${monitors?Object.keys(monitors.METRICS).join(', '):'—'}.`);
      else if(!monitors.OPS[c.op])
        errors.push(`"${c.op}" is not a comparison the monitors understand. Use: ${Object.keys(monitors.OPS).join(', ')}.`);
      else if(!c.description)
        errors.push(`The condition on ${c.metric} needs a plain-language description, so the alert can explain itself.`);
    }
    if(!conds.length&&!(d&&d.reviewBy))
      errors.push('A decision needs either a condition that should re-open it or a review date. Otherwise nothing will ever bring it back.');
    if(errors.length)return{error:errors.join(' ')};
    return{
      status:'proposed',
      decision:{
        id:d.id||`dec_${(o.now||new Date().toISOString()).replace(/\D/g,'').slice(0,14)}`,
        title:d.title,choice:d.choice||null,rationale:d.rationale,
        alternatives:d.alternatives||[],assumptions:d.assumptions||[],
        reconsiderWhen:conds,reviewBy:d.reviewBy||null,status:'active',
      },
      note:'NOT YET SAVED. Shown for confirmation — the user decides whether this is what they decided and why.',
    };
  }

  // ── The schemas the model sees ──────────────────────────────────────────
  const TOOLS=[
    {
      name:'compute',
      description:'Run the household projection and return named metrics. Use this for EVERY number you report — never calculate in your head. Pass `overrides` to model a change; omit it for the plan as it stands. Returns the assumptions behind the figures, which you should state alongside them.',
      input_schema:{type:'object',properties:{
        overrides:{type:'object',description:'Parameter changes, e.g. {"homePrice":2500000,"mortgageRate":6.5}. Rates are decimals (0.06); percentages of a price are whole numbers (20). An unknown key is an error, not a no-op.'},
        metrics:{type:'array',items:{type:'string'},
          description:`Which metrics to return. Available: ${Object.keys(METRICS).join(', ')}. Defaults to ${DEFAULT_METRICS.join(', ')}.`},
      },required:[]},
    },
    {
      name:'compare_alternatives',
      description:'Run two to six named alternatives against the same plan and return a comparison sorted by which metric they disagree about most, plus any assumptions that differ between them. Use this whenever the user is choosing between options — a table of measured outcomes beats a paragraph of reasoning about them. Include the current plan as an alternative with no overrides to measure a change against doing nothing.',
      input_schema:{type:'object',properties:{
        alternatives:{type:'array',description:'Each is {name, overrides}.',
          items:{type:'object',properties:{
            name:{type:'string'},overrides:{type:'object'},
          },required:['name']}},
        metrics:{type:'array',items:{type:'string'}},
      },required:['alternatives']},
    },
    {
      name:'lookup_tax_rule',
      description:'Return a tax figure with its year, jurisdiction, filing status, primary source and retrieval date. Call this before making ANY claim about a bracket, threshold, limit or cap — do not quote a tax figure from memory, and always state the year and jurisdiction when you use one.',
      input_schema:{type:'object',properties:{
        ruleId:{type:'string',description:taxRules?`One of: ${Object.keys(taxRules.RULES).join(', ')}`:'A rule id'},
      },required:['ruleId']},
    },
    {
      name:'propose_changes',
      description:'Stage a change to the plan for the user to review, with its measured impact against the current plan. This NEVER modifies anything — the user applies it or discards it. Use it instead of describing a change in prose when you are recommending one.',
      input_schema:{type:'object',properties:{
        overrides:{type:'object'},
        rationale:{type:'string',description:'What this is meant to achieve, and why it is worth doing.'},
        metrics:{type:'array',items:{type:'string'}},
      },required:['overrides','rationale']},
    },
    {
      name:'record_decision',
      description:'Stage a decision, its reasoning, the alternatives considered, and the conditions under which it should be revisited. Requires a rationale, and requires either a measurable reconsider condition or a review date — a decision with neither can never be brought back. Staged for confirmation; nothing is saved until the user accepts it.',
      input_schema:{type:'object',properties:{
        title:{type:'string'},
        choice:{type:'string',description:'What was decided.'},
        rationale:{type:'string',description:'Why. This is the part that makes it reviewable later.'},
        alternatives:{type:'array',items:{type:'string'},description:'What else was considered, and why it lost.'},
        assumptions:{type:'array',items:{type:'string'},description:'What has to stay true for this to remain right.'},
        reconsiderWhen:{type:'array',description:'Conditions that should re-open it.',
          items:{type:'object',properties:{
            metric:{type:'string',description:monitors?`One of: ${Object.keys(monitors.METRICS).join(', ')}`:'A measurable metric'},
            op:{type:'string',description:monitors?`One of: ${Object.keys(monitors.OPS).join(', ')}`:'A comparison'},
            value:{type:'number'},
            description:{type:'string',description:'In plain language, so the alert can explain itself.'},
          },required:['metric','op','value','description']}},
        reviewBy:{type:'string',description:'ISO date for a scheduled review.'},
      },required:['title','rationale']},
    },
    {
      name:'get_alerts',
      description:'Return the current monitoring result: the detected conditions with their evidence, the checks that could NOT run and why, and any that failed. Call this before saying anything about whether the plan is on track. You may explain what it found; you must NOT report a condition it did not detect, and when it reports a check was skipped you must say that rather than implying the area is clear.',
      input_schema:{type:'object',properties:{},required:[]},
    },
    {
      name:'get_projection',
      description:'Return the projection year by year, each with its EXPENSE COMPOSITION — housing, living, childcare, tuition and any one-off adjustment, which sum exactly to the total — alongside income, tax, net flow and balances. Call this whenever asked what a year costs or how a total breaks down; never say you can see a total but not what is inside it, and never add the parts up yourself. Pass `from`/`to` to narrow to the years being discussed. `overrides` runs a what-if first, so you can show a year before and after a change.',
      input_schema:{type:'object',properties:{
        from:{type:'integer',description:'First calendar year to return. Omit for the plan start.'},
        to:{type:'integer',description:'Last calendar year to return. Omit for the plan end.'},
        overrides:{type:'object',description:'Optional parameter changes to apply before running, same keys as compute.'},
      },required:[]},
    },
    {
      name:'get_spending',
      description:'Return what was ACTUALLY spent and earned, from the imported transaction ledger: month-by-month income and spending, the category rollup per month, trailing averages, and this month\'s pace against the household\'s own recent months. Call this before any claim about what a category costs, whether spending has drifted, or how the plan\'s cost inputs compare with reality — you have this data, so never ask the user to export a report from Monarch. Amounts are net of refunds; transfers between their own accounts and credit-card payments are excluded on purpose and reported separately so you can say so. Read `coverage` before you compare: `months` is what the ledger holds, `completeMonths` is the subset whose import was verified end-to-end, and the month in progress is a fraction of a month, never a data point.',
      input_schema:{type:'object',properties:{
        months:{type:'integer',description:'How many months of history to read. Defaults to 24.'},
      },required:[]},
    },
    {
      name:'get_tax_position',
      description:'Return projected liability against withholding and estimated payments, the safe-harbour test, and screened opportunities. Items marked requiresConfirmation have an eligibility question a professional must settle — present those as questions to ask, never as savings to count.',
      input_schema:{type:'object',properties:{},required:[]},
    },
  ];

  const api={TOOLS,METRICS,DEFAULT_METRICS,LIMITS,ENUMS,INDEXED,
    validateOverride,applyOverrides,knownKeys,measure,
    compute,getProjection,compareAlternatives,lookupTaxRule,proposeChanges,recordDecision};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerAdvisorTools=api;
})(typeof window!=='undefined'?window:this,
  typeof module!=='undefined'&&module.exports
    ?{model:require('./model.js'),taxRules:require('./tax-rules.js'),
      monitors:require('./monitors.js'),taxPlan:require('./tax-plan.js')}
    :(typeof window!=='undefined'
      ?{model:window,taxRules:window.PlannerTaxRules,monitors:window.PlannerMonitors,
        taxPlan:window.PlannerTaxPlan}:{}));
