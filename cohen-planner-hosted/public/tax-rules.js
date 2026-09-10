'use strict';
// ═══ AUTHORITATIVE TAX RULES — 2026, FEDERAL / NEW YORK STATE / NEW YORK CITY ═══
// Shared by the browser (<script>) and Node (tests), like model.js. No DOM, no I/O.
//
// Every figure in this file is a QUOTED rule with a year, a jurisdiction, and a citation to
// the document it came from. Nothing here is inferred, interpolated, or remembered — if a
// value is not in a primary source below, it does not belong in this file.
//
// This exists because the planner makes dollar claims about someone's tax bill. An engine
// carrying a stale bracket is not "approximately right"; it is confidently wrong, and it
// stays wrong silently for years. validate() below re-derives the engine's own constants and
// outputs from this table and reports every disagreement, so the answer to "is the tax math
// current?" is a test result rather than an opinion.
//
// RETRIEVAL. These were read from the primary sources on the RETRIEVED date. They are not
// self-updating. staleness() reports how old they are so a caller can say so out loud rather
// than presenting a two-year-old bracket as today's law.

(function(root){

  const RETRIEVED='2026-09-10';
  const TAX_YEAR=2026;

  // ── Sources ──────────────────────────────────────────────────────────────
  const SOURCES={
    RP2025_32:{
      id:'RP2025_32',
      title:'Rev. Proc. 2025-32 — Inflation-adjusted items for tax year 2026',
      publisher:'Internal Revenue Service',
      url:'https://www.irs.gov/pub/irs-drop/rp-25-32.pdf',
      jurisdiction:'US-Federal',retrieved:RETRIEVED,primary:true,
    },
    SSA_CBB:{
      id:'SSA_CBB',
      title:'Contribution and Benefit Base (Social Security taxable maximum)',
      publisher:'Social Security Administration',
      url:'https://www.ssa.gov/oact/cola/cbb.html',
      jurisdiction:'US-Federal',retrieved:RETRIEVED,primary:true,
    },
    NOTICE_2025_67:{
      id:'NOTICE_2025_67',
      title:'Notice 2025-67 — 2026 retirement plan cost-of-living adjustments',
      publisher:'Internal Revenue Service',
      url:'https://www.irs.gov/pub/irs-drop/n-25-67.pdf',
      jurisdiction:'US-Federal',retrieved:RETRIEVED,primary:true,
    },
    IRC_164:{
      id:'IRC_164',
      title:'IRC § 164(b)(6) as amended by P.L. 119-21 (OBBBA) — state and local tax deduction',
      publisher:'United States Code / Public Law 119-21',
      url:'https://www.law.cornell.edu/uscode/text/26/164',
      jurisdiction:'US-Federal',retrieved:RETRIEVED,primary:true,
    },
    IRC_1411:{
      id:'IRC_1411',
      title:'IRC § 1411 — Net Investment Income Tax',
      publisher:'United States Code',
      url:'https://www.law.cornell.edu/uscode/text/26/1411',
      jurisdiction:'US-Federal',retrieved:RETRIEVED,primary:true,
    },
    NYS50T:{
      id:'NYS50T',
      title:'NYS-50-T-NYS (1/26) — New York State Withholding Tax Tables and Methods',
      publisher:'New York State Department of Taxation and Finance',
      url:'https://www.tax.ny.gov/pdf/publications/withholding/nys50_t_nys.pdf',
      jurisdiction:'US-NY',retrieved:RETRIEVED,primary:true,
      note:'Confirms the 2026 marginal rates enacted by Chapter 59 of the Laws of 2025 (Part A). '+
           'The printed schedule is a withholding schedule on half-of-joint wages; the statutory '+
           'joint bracket thresholds come from NY Tax Law § 601.',
    },
    NY_TAX_601:{
      id:'NY_TAX_601',
      title:'NY Tax Law § 601 — rates of tax (joint returns)',
      publisher:'New York State Legislature',
      url:'https://www.nysenate.gov/legislation/laws/TAX/601',
      jurisdiction:'US-NY',retrieved:RETRIEVED,primary:true,
    },
    NYC_ADCODE:{
      id:'NYC_ADCODE',
      title:'NYC Administrative Code § 11-1701 — city personal income tax rates',
      publisher:'City of New York',
      url:'https://www.nyc.gov/site/finance/taxes/personal-income-tax.page',
      jurisdiction:'US-NYC',retrieved:RETRIEVED,primary:true,
    },
  };

  // ── The rules themselves ─────────────────────────────────────────────────
  // `indexed` says whether the figure moves with inflation on its own. It matters as much as
  // the number: a projection that escalates an UNINDEXED threshold understates tax in every
  // future year, and one that freezes an indexed threshold overstates it.
  const RULES={
    fedBracketsMFJ:{
      year:TAX_YEAR,jurisdiction:'US-Federal',filingStatus:'MFJ',
      label:'Federal ordinary income brackets, married filing jointly',
      value:[[24800,.10],[100800,.12],[211400,.22],[403550,.24],[512450,.32],[768700,.35],[Infinity,.37]],
      indexed:true,source:'RP2025_32',citation:'§ 3.01, Table 1',
    },
    fedStandardDeductionMFJ:{
      year:TAX_YEAR,jurisdiction:'US-Federal',filingStatus:'MFJ',
      label:'Federal standard deduction, married filing jointly',
      value:32200,indexed:true,source:'RP2025_32',citation:'§ 3.14(1)',
    },
    fedLTCGThresholdsMFJ:{
      year:TAX_YEAR,jurisdiction:'US-Federal',filingStatus:'MFJ',
      label:'Long-term capital gain rate thresholds, married filing jointly',
      value:{zeroRateTop:98900,fifteenRateTop:613700,topRate:.20},
      indexed:true,source:'RP2025_32',citation:'§ 3.03',
    },
    childTaxCredit:{
      year:TAX_YEAR,jurisdiction:'US-Federal',
      label:'Child tax credit, maximum per qualifying child',
      value:2200,indexed:true,source:'RP2025_32',citation:'§ 3.05(1)',
    },
    qbiThresholdMFJ:{
      year:TAX_YEAR,jurisdiction:'US-Federal',filingStatus:'MFJ',
      label:'§ 199A qualified business income threshold and phase-in range',
      // The phase-in RANGE amount is the top of the band, not its width: the band runs from
      // $403,500 to $553,500, so it is $150,000 wide.
      value:{threshold:403500,phaseInTop:553500,bandWidth:150000},
      indexed:true,source:'RP2025_32',citation:'§ 3.26',
    },
    socialSecurityWageBase:{
      year:TAX_YEAR,jurisdiction:'US-Federal',
      label:'Social Security contribution and benefit base',
      value:184500,indexed:true,source:'SSA_CBB',citation:'Contribution and benefit base table',
    },
    additionalMedicareThresholdMFJ:{
      year:TAX_YEAR,jurisdiction:'US-Federal',filingStatus:'MFJ',
      label:'Additional Medicare Tax threshold (0.9%), married filing jointly',
      // Statutory and NOT indexed — fixed at $250,000 since 2013.
      value:{threshold:250000,rate:.009},indexed:false,
      source:'IRC_1411',citation:'IRC § 3101(b)(2)',
    },
    niitMFJ:{
      year:TAX_YEAR,jurisdiction:'US-Federal',filingStatus:'MFJ',
      label:'Net Investment Income Tax, married filing jointly',
      // Also statutory and NOT indexed. Any household above $250K of MAGI pays it on every
      // dollar of investment income, which for this plan means capital gains on stock sales.
      value:{threshold:250000,rate:.038},indexed:false,
      source:'IRC_1411',citation:'IRC § 1411(a)(1), (b)(1)',
    },
    saltCap:{
      year:TAX_YEAR,jurisdiction:'US-Federal',
      label:'State and local tax deduction cap, with income phase-down',
      value:{cap:40400,phaseoutStart:505000,phaseoutRate:.30,floor:10000,
        // These two facts are why a projection cannot just escalate the cap: it grows at a
        // statutory 1%/yr, and then it is gone.
        annualGrowth:.01,growsThrough:2029,revertsTo:10000,revertsIn:2030},
      indexed:false,source:'IRC_164',citation:'IRC § 164(b)(6)(B)-(C) as amended by P.L. 119-21 § 70120',
    },
    mortgageInterestPrincipalCap:{
      year:TAX_YEAR,jurisdiction:'US-Federal',
      label:'Acquisition indebtedness limit for the mortgage interest deduction',
      value:750000,indexed:false,source:'IRC_164',citation:'IRC § 163(h)(3)(F)',
    },
    elective401kDeferral:{
      year:TAX_YEAR,jurisdiction:'US-Federal',
      label:'§ 402(g) elective deferral limit',
      value:24500,indexed:true,source:'NOTICE_2025_67',citation:'Notice 2025-67 § 1',
    },
    nysBracketsMFJ:{
      year:TAX_YEAR,jurisdiction:'US-NY',filingStatus:'MFJ',
      label:'New York State income tax brackets, married filing jointly',
      // Chapter 59 of the Laws of 2025 (Part A) cut each of the five lowest rates by 0.1
      // point for 2026, with a further 0.1 point in 2027. The thresholds did not move.
      value:[[17150,.0390],[23600,.0440],[27900,.0515],[161550,.0540],[323200,.0590],
             [2155350,.0685],[5000000,.0965],[25000000,.1030],[Infinity,.1090]],
      // New York does NOT index its brackets. The dollar thresholds are fixed in statute.
      indexed:false,source:'NYS50T',citation:'Annual Tax Rate Schedule, married (p. 21); rates per Ch. 59 L.2025 Pt. A',
    },
    nycBracketsMFJ:{
      year:TAX_YEAR,jurisdiction:'US-NYC',filingStatus:'MFJ',
      label:'New York City resident income tax brackets, married filing jointly',
      value:[[21600,.03078],[45000,.03762],[90000,.03819],[Infinity,.03876]],
      indexed:false,source:'NYC_ADCODE',citation:'NYC Admin. Code § 11-1701(a)',
    },
  };

  function rule(id){
    const r=RULES[id];
    if(!r)throw new Error('No such tax rule: '+id);
    return{...r,sourceRef:SOURCES[r.source]};
  }

  // A citation string a person can check, rather than a number a model asserts.
  function cite(id){
    const r=rule(id);
    return`${r.label} (${r.year}, ${r.jurisdiction}${r.filingStatus?', '+r.filingStatus:''}): `+
      `${r.sourceRef.publisher}, ${r.sourceRef.title}, ${r.citation}. `+
      `${r.sourceRef.url} — retrieved ${r.sourceRef.retrieved}.`;
  }

  // How old this table is. The advisor states this rather than implying the figures are live.
  function staleness(today){
    const now=today?new Date(today):new Date();
    const days=Math.floor((now-Date.parse(RETRIEVED))/86400000);
    const currentTaxYear=now.getMonth()>=10?now.getFullYear()+1:now.getFullYear();
    return{retrieved:RETRIEVED,ageDays:days,taxYear:TAX_YEAR,
      // Inflation adjustments for the next year land each autumn. Once the table's year is
      // behind the year a filer is actually planning for, the figures are last year's.
      coversCurrentYear:TAX_YEAR>=currentTaxYear,
      note:TAX_YEAR>=currentTaxYear
        ?`Figures are for tax year ${TAX_YEAR}, read from primary sources on ${RETRIEVED}.`
        :`Figures are for tax year ${TAX_YEAR} but planning is now for ${currentTaxYear}. Re-read the sources before relying on any dollar threshold.`};
  }

  // ── Validation ───────────────────────────────────────────────────────────
  // Compares the ENGINE against the table. Deliberately reports rather than repairs: a
  // discrepancy might be a stale constant (fix the engine) or a deliberate modeling
  // simplification (document it), and only a person can tell which.
  const SEV={ERROR:'error',WARN:'warning',INFO:'info'};

  const bracketsEqual=(a,b)=>{
    if(a.length!==b.length)return false;
    return a.every(([t,r],i)=>{
      const [t2,r2]=b[i];
      const bothTop=(t>=1e14||t===Infinity)&&(t2>=1e14||t2===Infinity);
      return (bothTop||Math.abs(t-t2)<1)&&Math.abs(r-r2)<1e-9;
    });
  };

  function validate(engine,opts){
    const o=opts||{};
    const f=[];
    const add=(id,severity,label,expected,actual,impact,fix)=>
      f.push({id,severity,label,expected,actual,impact,fix,
        rule:id in RULES?cite(id):null,checkedAt:o.today||RETRIEVED});

    // Federal brackets
    const fed=RULES.fedBracketsMFJ.value;
    if(engine.FED_BR_2026&&!bracketsEqual(engine.FED_BR_2026,fed)){
      const mismatch=fed.map(([t,r],i)=>{
        const got=engine.FED_BR_2026[i];
        return got&&Math.abs((got[0]>=1e14?Infinity:got[0])-t)>1?{rate:r,expected:t,actual:got[0]}:null;
      }).filter(Boolean);
      add('fedBracketsMFJ',SEV.ERROR,'Federal MFJ brackets do not match Rev. Proc. 2025-32',
        fed,engine.FED_BR_2026,
        mismatch.map(m=>`the ${(m.rate*100).toFixed(0)}% band ends at ${m.expected.toLocaleString()}, engine has ${m.actual.toLocaleString()}`).join('; '),
        'Update FED_BR_2026 in model.js to the Rev. Proc. 2025-32 Table 1 thresholds.');
    }

    if(engine.STD_DEDUCT_2026!=null&&engine.STD_DEDUCT_2026!==RULES.fedStandardDeductionMFJ.value)
      add('fedStandardDeductionMFJ',SEV.ERROR,'Federal standard deduction differs',
        RULES.fedStandardDeductionMFJ.value,engine.STD_DEDUCT_2026,
        'Every year of the projection deducts the wrong amount.',
        'Update STD_DEDUCT_2026 in model.js.');

    if(engine.SS_CAP_2026!=null&&engine.SS_CAP_2026!==RULES.socialSecurityWageBase.value)
      add('socialSecurityWageBase',SEV.ERROR,'Social Security wage base differs',
        RULES.socialSecurityWageBase.value,engine.SS_CAP_2026,
        'Shifts FICA on every wage dollar near the cap.',
        'Update SS_CAP_2026 in model.js.');

    if(engine.SALT_BASE_2026!=null&&engine.SALT_BASE_2026!==RULES.saltCap.value.cap)
      add('saltCap',SEV.ERROR,'SALT cap base differs',
        RULES.saltCap.value.cap,engine.SALT_BASE_2026,
        'Changes itemized deductions in every year before the 2030 reversion.',
        'Update SALT_BASE_2026 in model.js.');

    // State and city
    const nys=RULES.nysBracketsMFJ.value;
    if(engine.NYS_BR_2026&&!bracketsEqual(engine.NYS_BR_2026,nys)){
      const rateDiffs=nys.map(([t,r],i)=>{
        const got=engine.NYS_BR_2026[i];
        return got&&Math.abs(got[1]-r)>1e-9?`${(t>=1e14?'top':'≤$'+t.toLocaleString())}: ${(r*100).toFixed(2)}% per statute, engine has ${(got[1]*100).toFixed(2)}%`:null;
      }).filter(Boolean);
      add('nysBracketsMFJ',SEV.ERROR,'New York State brackets do not match the 2026 schedule',
        nys,engine.NYS_BR_2026,
        rateDiffs.length?rateDiffs.join('; '):'Thresholds differ from NY Tax Law § 601.',
        'Update NYS_BR_2026 in model.js. Chapter 59 of the Laws of 2025 (Part A) cut each of the five lowest rates by 0.1 point for 2026.');
    }

    if(engine.NYC_BR_2026&&!bracketsEqual(engine.NYC_BR_2026,RULES.nycBracketsMFJ.value))
      add('nycBracketsMFJ',SEV.ERROR,'New York City brackets differ',
        RULES.nycBracketsMFJ.value,engine.NYC_BR_2026,
        'Changes city tax at every income level.','Update NYC_BR_2026 in model.js.');

    // ── Indexation, which is a rule as much as any dollar figure ───────────
    // The engine escalates every schedule by one `taxInflation` rate. That is right for the
    // federal schedule and wrong for New York's, which is fixed in statute.
    if(o.taxInflation>0&&o.indexStateBrackets)
      add('nysBracketsMFJ',SEV.WARN,'New York brackets are escalated, but New York does not index them',
        'fixed dollar thresholds in every projection year',
        `escalated ${(o.taxInflation*100).toFixed(1)}%/yr`,
        'Nominal income rises against frozen statutory brackets, so real New York liability grows over time. Escalating the brackets hides that, understating state and city tax in every later year.',
        'Hold NYS_BR_2026 and NYC_BR_2026 flat while continuing to index the federal schedule.');
    if(o.taxInflation>0)
      add('saltCap',SEV.WARN,'SALT cap is escalated at the general tax-inflation rate and never reverts',
        '1%/yr through 2029, then $10,000 from 2030',
        `escalated ${(o.taxInflation*100).toFixed(1)}%/yr indefinitely`,
        'Overstates the deduction from 2030 on. At a MAGI above about $606K the 30% phase-down already lands on the $10,000 floor, so a high-income year is unaffected — but a low-income year is not.',
        'Grow SALT_BASE_2026 at 1%/yr through 2029 and drop it to $10,000 from 2030.');

    // ── QBI ────────────────────────────────────────────────────────────────
    if(o.qbiPhaseBase!=null&&o.qbiPhaseBase!==RULES.qbiThresholdMFJ.value.threshold)
      add('qbiThresholdMFJ',SEV.ERROR,'§ 199A threshold is out of date',
        RULES.qbiThresholdMFJ.value.threshold,o.qbiPhaseBase,
        'The deduction starts phasing out at the wrong income.',
        'Use the Rev. Proc. 2025-32 § 3.26 threshold of $403,500 for MFJ.');
    if(o.qbiBandWidth!=null&&o.qbiBandWidth!==RULES.qbiThresholdMFJ.value.bandWidth)
      add('qbiThresholdMFJ',SEV.ERROR,'§ 199A phase-in band is the wrong width',
        RULES.qbiThresholdMFJ.value.bandWidth,o.qbiBandWidth,
        'A band that is too narrow phases the deduction out too fast, overstating tax.',
        'The 2026 band runs $403,500 → $553,500, so it is $150,000 wide.');

    // ── Things the engine does not model at all ────────────────────────────
    // Silence about a tax is not neutrality; it is a claim that the tax is zero.
    if(o.modelsNIIT===false)
      add('niitMFJ',SEV.WARN,'Net Investment Income Tax is not computed separately',
        '3.8% on investment income above $250,000 MAGI',
        o.capGainsTaxRate!=null?`folded into a flat ${(o.capGainsTaxRate*100).toFixed(1)}% capital gains rate`:'not modeled',
        o.capGainsTaxRate!=null&&o.capGainsTaxRate>=.30
          ?'The blended rate is in the right region for a top-bracket New York City filer (20% federal + 3.8% NIIT + state + city), so totals are close. But interest and dividends inside the taxable portfolio also attract NIIT and are not charged for it.'
          :'Capital gains are undertaxed.',
        'Either keep the blended rate and document what it includes, or compute the federal rate, NIIT, state and city separately.');

    if(o.modelsAMT===false)
      add('fedBracketsMFJ',SEV.INFO,'Alternative Minimum Tax is not modeled',
        'AMT computed alongside regular tax',null,
        'For a wage-and-RSU household with a capped SALT deduction, AMT rarely binds. It can bind on a large ISO exercise, which this plan does not contain.',
        'Leave as is unless incentive stock options enter the picture.');

    // ── Behavioural check: re-derive the engine\'s own output ───────────────
    // Constants can be right while the code that uses them is not, so this recomputes a
    // known figure straight from the rule table and compares.
    if(typeof engine.bracketTax==='function'){
      const probe=[[0,0],[24800,2480],[100800,11600],[211400,35932],[403550,82048],
        [512450,116896],[768700,206583.5]];
      for(const [income,expected] of probe){
        const got=engine.bracketTax(income,fed);
        if(Math.abs(got-expected)>1)
          add('fedBracketsMFJ',SEV.ERROR,`bracketTax($${income.toLocaleString()}) disagrees with Rev. Proc. 2025-32 Table 1`,
            expected,Math.round(got),'The bracket walk itself is wrong, not just a constant.',
            'Check bracketTax(): each row\'s value is the cumulative tax at the TOP of that band.');
      }
    }

    const bySeverity=s=>f.filter(x=>x.severity===s).length;
    return{findings:f,checkedAt:o.today||RETRIEVED,taxYear:TAX_YEAR,
      errors:bySeverity(SEV.ERROR),warnings:bySeverity(SEV.WARN),
      // "Validated" means every ERROR is clear. Warnings are documented modeling choices.
      passed:bySeverity(SEV.ERROR)===0,
      staleness:staleness(o.today)};
  }

  const api={RULES,SOURCES,SEV,TAX_YEAR,RETRIEVED,rule,cite,staleness,validate};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerTaxRules=api;
})(typeof window!=='undefined'?window:this);
