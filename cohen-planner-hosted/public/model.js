'use strict';
// ═══ COHEN FAMILY FINANCIAL PLANNER — PURE ENGINE ═══
// Shared by browser (loaded via <script>) and Node (require'd by tests).
// No DOM dependencies. No global state.

// ── 2026 base tax constants (MFJ, OBBBA rules) ──
// Rev. Proc. 2025-32 § 3.01 Table 1 (MFJ, tax year 2026). Verified against the source by
// tax-rules.js — the 35% band previously ended at 731,200, which is not a 2026 figure.
const FED_BR_2026=[[24800,.10],[100800,.12],[211400,.22],[403550,.24],[512450,.32],[768700,.35],[1e15,.37]];
// NY Tax Law § 601 thresholds with the rates enacted by Chapter 59 of the Laws of 2025
// (Part A), which cut each of the five lowest rates by 0.1 point for 2026 (a further 0.1
// point lands in 2027). Confirmed against NYS-50-T-NYS (1/26).
const NYS_BR_2026=[[17150,.0390],[23600,.0440],[27900,.0515],[161550,.0540],[323200,.0590],[2155350,.0685],[5e6,.0965],[25e6,.103],[1e15,.109]];
const NYC_BR_2026=[[21600,.03078],[45000,.03762],[90000,.03819],[1e15,.03876]];
const SS_CAP_2026=184500;
const SALT_BASE_2026=40400;
const STD_DEDUCT_2026=32200;

function _scaleBr(brackets,f){
  return brackets.map(([top,r])=>[top>=1e14?1e15:Math.round(top*f),r]);
}

function bracketTax(income,brackets){
  let t=0,p=0;
  for(const[top,r]of brackets){const c=Math.min(income,top)-p;if(c<=0)break;t+=c*r;p=top}
  return t;
}

function calcTax(grossIncome,p,yr,numKids){
  const sy=p.planStartYear||2026;
  const taxInf=p.taxInflation??0.025;
  const f=(1+taxInf)**(yr-sy);

  const FED_BR=_scaleBr(FED_BR_2026,f);
  // The federal schedule is indexed by statute. New York's is NOT: § 601 and the NYC
  // Administrative Code set fixed dollar thresholds that only move when the legislature
  // moves them. Escalating them alongside nominal income cancels out real bracket creep
  // that a New York filer actually experiences, understating state and city tax in every
  // later year. `indexStateBrackets` exists only so a saved plan can reproduce the old
  // behaviour on request; the default follows the law.
  const sf=(p.indexStateBrackets??false)?f:1;
  const NYS_BR=_scaleBr(NYS_BR_2026,sf);
  const NYC_BR=_scaleBr(NYC_BR_2026,sf);
  const ssCap=Math.round(SS_CAP_2026*f);
  const saltBase=Math.round(SALT_BASE_2026*f);
  const stdDeduct=Math.round(STD_DEDUCT_2026*f);

  const pretax=p.pretax401k+p.pretaxBenefits;
  const normW2=p._normW2||0;const nancyW2=p._nancyW2||0;const nancySE=p._nancySE||0;
  const overhead=p._nancyOverhead||0;

  // ── FICA / SE tax (computed first: half SE tax is deductible above the line) ──
  const normSS=Math.min(normW2,ssCap)*.062;
  const normMed=normW2*.0145;
  let nancySS=0,nancyMed=0,seTaxHalf=0;
  if(nancySE>0){
    const seBase=nancySE*.9235;
    nancySS=Math.min(seBase,ssCap)*.124;
    nancyMed=seBase*.029;
    seTaxHalf=.5*(nancySS+nancyMed);
  } else {
    nancySS=Math.min(nancyW2,ssCap)*.062;
    nancyMed=nancyW2*.0145;
  }
  const combinedMedWages=normW2+(nancySE>0?nancySE*.9235:nancyW2);
  const addlMedicare=Math.max(0,combinedMedWages-250000)*.009;
  const totalFICA=normSS+normMed+nancySS+nancyMed+addlMedicare;

  // ── AGI ──
  const agi=Math.max(0,(normW2+nancyW2+nancySE)-pretax-seTaxHalf);

  // ── Itemized deductions ──
  const saltPhaseout=Math.max(0,(agi-505000)*0.30);
  const saltCap=Math.max(10000,saltBase-saltPhaseout);
  let mortInt=0,deductibleMortInt=0;
  if(yr>=p.homePurchaseYear){
    const mortAmt=p.homePrice*(1-p.downPctg/100);
    const mr=p.mortgageRate/100/12;const n=360;
    const pmt=mortAmt*(mr*(1+mr)**n)/((1+mr)**n-1);
    let bal=mortAmt;
    for(let y=0;y<yr-p.homePurchaseYear;y++){for(let m=0;m<12;m++){bal-=(pmt-bal*mr)}}
    for(let m=0;m<12;m++){mortInt+=bal*mr;bal-=(pmt-bal*mr)}
    const mortCap=750000;
    deductibleMortInt=mortInt*Math.min(1,mortCap/mortAmt);
  }
  const charityPaid=(p.baseCharity||0)*(1+(p.expenseInflation||0))**(yr-sy);
  const deductibleCharity=Math.max(0,charityPaid-0.005*agi);
  const itemized=saltCap+deductibleMortInt+deductibleCharity;
  const deduction=Math.max(stdDeduct,itemized);

  // ── QBI ──
  let qbi=0;
  if(nancySE>0){
    const qbiBase=Math.max(0,nancySE-seTaxHalf)*p.nancyQBIRate;
    // Rev. Proc. 2025-32 § 3.26: the 2026 MFJ band runs 403,500 → 553,500. The previous
    // 383,900 → 483,900 was the 2024 band, and it was $150K wide, not $100K.
    const qbiPhaseBase=403500*f;
    const qbiPhaseTop=553500*f;
    const qbiBandWidth=(553500-403500)*f;
    if(agi<qbiPhaseBase)qbi=qbiBase;
    // Phaseout band width must scale with `f` too (qbiPhaseTop-qbiPhaseBase), not stay
    // flat at $100K — otherwise the phaseout runs too fast in later (inflated) years and
    // can drive qbi negative, which would perversely *increase* taxable income.
    else if(agi<qbiPhaseTop)qbi=Math.max(0,qbiBase*(1-(agi-qbiPhaseBase)/qbiBandWidth));
  }

  const fedTaxable=Math.max(0,agi-deduction-qbi);
  let federal=bracketTax(fedTaxable,FED_BR);
  if(numKids>0){
    const ctcPerKid=2200*f; // also index CTC
    let ctc=numKids*ctcPerKid;
    const ctcPhaseBase=400000*f;
    if(agi>ctcPhaseBase)ctc=Math.max(0,ctc-Math.ceil((agi-ctcPhaseBase)/1000)*50);
    federal=Math.max(0,federal-ctc);
  }

  const nysTaxable=Math.max(0,agi-16050);
  const stateT=bracketTax(nysTaxable,NYS_BR);
  const cityT=bracketTax(nysTaxable,NYC_BR);
  const incomeTax=federal+stateT+cityT;
  const allInTax=incomeTax+Math.max(0,totalFICA);
  const effRate=grossIncome>0?allInTax/grossIncome:0;
  const net=grossIncome-allInTax-pretax-overhead;
  return{
    allInTax:Math.round(allInTax),incomeTax:Math.round(incomeTax),
    fica:Math.round(Math.max(0,totalFICA)),federal:Math.round(federal),
    state:Math.round(stateT),city:Math.round(cityT),effRate,
    net:Math.round(net),gross:Math.round(grossIncome),agi:Math.round(agi),
    deduction:Math.round(deduction),qbi:Math.round(qbi),saltCap:Math.round(saltCap),
    mortInt:Math.round(mortInt),itemizing:itemized>stdDeduct
  };
}

function baseTuit(a){
  if(a===2)return 14000;if(a===3)return 12000;if(a===4)return 12000;
  if(a===5)return 25450;if(a<=10)return 31950;if(a<=13)return 35950;
  if(a<=16)return 39500;if(a===17)return 27500;return 0;
}
function kidCost(a){
  if(a<1)return{g:2500,d:-3000,s:4000,m:3000,x:2500,e:0,v:0};
  if(a<3)return{g:2000,d:-2000,s:2500,m:1500,x:2500,e:0,v:0};
  if(a<6)return{g:2500,d:-1000,s:2000,m:1500,x:2000,e:500,v:1000};
  if(a<10)return{g:3000,d:0,s:2500,m:1000,x:3000,e:500,v:1000};
  if(a<13)return{g:3500,d:0,s:2500,m:1000,x:3000,e:500,v:1000};
  return{g:4500,d:500,s:3500,m:1000,x:4000,e:500,v:1000};
}
function mPmt(pr,r,y=30){if(pr<=0||r<=0)return 0;const m=r/12,n=y*12;return pr*(m*(1+m)**n)/((1+m)**n-1)*12}
function mBal(pr,r,yp,ty=30){if(yp>=ty||pr<=0)return 0;const m=r/12,n=ty*12,pp=yp*12;return pr*((1+m)**n-(1+m)**pp)/((1+m)**n-1)}

const NORM_COMP_YEARS=11; // explicit per-year comp inputs: Y0 (planStartYear) through Y10
const STRIPE_RET_YEARS=10; // explicit per-year Stripe return assumptions: Y0 through Y9

// ── Norm's compensation ────────────────────────────────────────────────────
// Cash and stock are tracked separately because they behave completely differently AFTER
// tax: cash lands in the checking account and is spendable; stock lands as an ASSET that
// only becomes spendable if it is sold. For TAX purposes they are identical — both are
// ordinary W2 income at vest — so calcTax() still sees one combined normW2 figure.
// Past the explicit window each stream compounds at its own growth rate.
function normComp(p,yIdx){
  const last=NORM_COMP_YEARS-1;
  const cashAt=i=>p['normCashY'+i]??275000;
  const stockAt=i=>p['normStockY'+i]??150000;
  if(yIdx<NORM_COMP_YEARS)return{cash:cashAt(yIdx),stock:stockAt(yIdx)};
  const n=yIdx-last;
  return{
    cash:cashAt(last)*(1+(p.normGrowth??0.01))**n,
    stock:stockAt(last)*(1+(p.normStockGrowth??p.normGrowth??0.01))**n,
  };
}

// ── Stripe equity ──────────────────────────────────────────────────────────
// Stripe is a single concentrated private-company position, NOT the diversified
// portfolio, so it gets its own explicit return path rather than p.investReturn.
function stripeReturn(p,yIdx){
  if(yIdx<STRIPE_RET_YEARS){
    const v=p['stripeRetY'+yIdx];
    if(typeof v==='number'&&isFinite(v))return v;
  }
  return p.stripeLongTermReturn??0.08;
}

// Average in-year growth factor for ONE year's grant, vesting in 4 equal quarterly lots.
// A lot vesting at the end of quarter q has (4-q)/4 of the year left to appreciate, so the
// Q4 lot earns nothing this year and the Q1 lot earns 9 months' worth. Without this, a
// grant that mostly vests in December would be credited a full year of appreciation.
// SUPERSEDED by the tender calendar below, and kept only so an older saved analysis can
// still be reproduced. It modelled Stripe as appreciating continuously through the year, so
// a Q1 vest earned nine months of growth and a Q4 vest earned none. A private company with
// discrete tender marks does not work that way: every share is worth the same February mark
// regardless of which quarter it vested in. stripeVestFactor is no longer used by run().
function stripeVestFactor(sr){
  let f=0;
  for(let q=1;q<=4;q++)f+=(1+sr)**((4-q)/4);
  return f/4;
}

// ── The tender calendar ────────────────────────────────────────────────────
// Stripe is private, so there is no continuous price. The only number anything transacts at
// is the mark set at the February tender, and it holds until the NEXT February tender. Two
// consequences run through the whole model:
//
//   1. A sale during year Y executes at the Feb-Y mark. Year Y's return is not realisable
//      until Feb Y+1. So growth is credited at year END, after that year's sales.
//   2. A position observed mid-year is stated at the Feb mark and ALREADY CONTAINS every
//      vest that has landed so far this year.
//
// Vest months default to Feb/May/Aug/Nov. That is an assumption, stated openly rather than
// buried: it is what makes a position observed in August contain three of the year's four
// quarterly vests, and it puts the first vest on the same month as the tender.
const STRIPE_VEST_MONTHS=[2,5,8,11];

// The fraction of a year's grant that has NOT yet vested as of `month` (1-12). In the year
// the opening balance was observed, only this fraction is new equity — the rest is already
// inside the observed number, and adding it again would count it twice.
function stripeVestRemaining(p){
  const months=p.stripeVestMonths||STRIPE_VEST_MONTHS;
  const asOf=p.stripeObservedMonth;
  if(asOf==null)return 1;                       // no observation date given: assume Jan 1
  const landed=months.filter(m=>m<=asOf).length;
  return Math.max(0,(months.length-landed)/months.length);
}

// ── Tax withheld on a vest ─────────────────────────────────────────────────
// What lands in the brokerage account is NOT the grant. Shares are withheld at vest to
// cover the income tax, and what remains — the after-tax position — is the number a person
// reads off their equity portal. Adding a GROSS grant to an AFTER-TAX opening balance
// overstates the holding by the entire withholding, every single year.
//
// Two ways to price it, and the difference matters:
//   • The household's MARGINAL rate. Exact, self-consistent with the rest of the engine,
//     and the right answer for the tax ultimately owed. This is the default because it is
//     derived rather than assumed.
//   • The actual SUPPLEMENTAL WITHHOLDING rate the employer applies (a flat federal rate
//     plus flat state and city rates). This is what determines how many shares are really
//     withheld, and it is usually not the marginal rate. Supply it from a paystub as
//     `stripeVestWithholdingRate` and the model uses it instead.
// Either way the identity holds: cash + after-tax equity = total after-tax compensation.
// Over- or under-withholding simply moves the difference between the two, which is exactly
// what it does in life when the return is filed.
function vestTaxRate(p,taxAll,taxParams,grossIncome,yr,ctcKids,normStock){
  const override=p.stripeVestWithholdingRate;
  if(override!=null&&override>=0&&override<1)return override;
  if(normStock<=0)return 0;
  // Marginal: what the household's whole tax bill would be without the grant. The stock is
  // the top slice of income, so its incremental tax is the difference.
  const without=calcTax(grossIncome-normStock,
    {...taxParams,_normW2:Math.max(0,(taxParams._normW2||0)-normStock)},yr,ctcKids);
  return Math.min(0.9,Math.max(0,(taxAll.allInTax-without.allInTax)/normStock));
}

// ── Stripe lot ledger ──────────────────────────────────────────────────────
// Holdings are kept as dated lots {v: value, b: cost basis, yr: vest year} rather than one
// blended pool, because a forced sale picks lots by specific identification: the ones with
// the SMALLEST unrealised gain go first, since tax per dollar raised is (gain/value) × rate.
// Averaging basis across every lot would overstate the tax on every forced sale — the newest
// shares have barely appreciated and are exactly what you would sell in practice.
function lotsValue(lots){let t=0;for(const L of lots)t+=L.v;return t}
function lotsBasis(lots){let t=0;for(const L of lots)t+=L.b;return t}

// Raise `netNeeded` in after-tax cash from `lots`, cheapest-to-sell first. Mutates the lots.
function sellLots(lots,netNeeded,capRate){
  let gross=0,tax=0,need=netNeeded;
  // Ascending unrealised-gain fraction. Ties and zero-value lots fall out harmlessly.
  const order=[...lots].sort((a,b)=>
    (a.v>0?(a.v-a.b)/a.v:0)-(b.v>0?(b.v-b.b)/b.v:0));
  for(const L of order){
    if(need<=1e-6||L.v<=1e-6)continue;
    const gainFrac=Math.max(0,(L.v-L.b)/L.v);
    const rate=gainFrac*capRate;
    const take=Math.min(need/(1-rate),L.v);
    const frac=take/L.v;              // capture before mutating
    L.b*=Math.max(0,1-frac);          // basis leaves proportionally with the shares sold
    L.v-=take;
    gross+=take;tax+=take*rate;need-=take*(1-rate);
  }
  return{gross,tax,shortfall:Math.max(0,need)};
}

// How much of this year's NEWLY VESTED stock to sell for cash, per the retention policy.
// Always returns a vest-date dollar amount within [0, newStock]; legacy/previously-retained
// Stripe is never sold automatically under any policy.
//   netCash  — the year's cash flow before any stock sale (negative = shortfall)
//   liqGrown — the diversified pool after a full year of return, before this year's flows
//   td       — effective tax drag on liquidating diversified assets
function stripeSellAmount(p,newStock,netCash,liqGrown,ret,td){
  const need=Math.max(0,-netCash);
  const clamp=x=>Math.max(0,Math.min(newStock,x));
  // Minimum sale that leaves the diversified pool at or above `floor` at year end.
  // Solved in closed form off the same half-year-convention arithmetic used below, so the
  // policies stay deterministic instead of needing a search.
  const sellForFloor=floor=>{
    const depositNeeded=(floor-liqGrown)/(1+ret/2);
    if(depositNeeded>=0)return depositNeeded-netCash; // pool is short: cash must go IN
    const maxDraw=(liqGrown-floor)*(1-td)/(1+ret/2);  // pool can absorb this much
    return need-maxDraw;
  };
  switch(p.stripePolicy||'deficit'){
    case 'sell':   return newStock;                    // treat all vesting stock as cash
    // "Retain all" still sells if the diversified pool would otherwise go negative —
    // holding stock while the checking account overdrafts isn't a real-world option.
    case 'retain': return clamp(sellForFloor(0));
    case 'floor':  return clamp(sellForFloor(p.liquidReserveFloor??p.stripeLiquidFloor??500000));
    // Fixed % carries the same solvency backstop, so a low % can't silently bankrupt the
    // plan while a year's worth of sellable stock sits untouched.
    case 'pct':    return clamp(Math.max(newStock*(p.stripeSellPct??0.3),sellForFloor(0)));
    case 'deficit':
    default:       return clamp(need); // sell only enough to close this year's cash gap
  }
}

// Years the plan actually reaches for savings — see the note at the return of run().
// Exported so UI code holding only the rows asks exactly the same question the engine does.
function drawYears(R){return R.filter(r=>r.sold>0||r.sHold>0).length}

function run(p,rets){
  const sy=p.planStartYear||2026;
  const ey=p.planEndYear||2058;
  const kids=[p.kid1Birth];
  if(p.numKids>=2)kids.push(p.kid2Birth);
  if(p.numKids>=3)kids.push(p.kid3Birth);
  if(p.numKids>=4)kids.push(p.kid4Birth);
  const dp=p.homePrice*(p.downPctg/100),ma=p.homePrice-dp,am=mPmt(ma,p.mortgageRate/100);
  let liq=p.startingLiquid,k401=p.k401Start||210000,tT=0,tC=0,tTx=0,tS=0;
  // Stripe equity is a wholly separate pool from the diversified `liq`. Basis matters
  // because RSU cost basis IS the vest-date FMV — selling at vest produces essentially no
  // capital gain (the W2 tax was already paid), and only post-vest appreciation is ever a
  // taxable gain. Pre-existing holdings default to basis = value for the same reason.
  // Pre-existing holdings start as a single lot. Basis defaults to full value because these
  // are vested RSUs, whose basis IS the vest-date price.
  const lots=[];
  if((p.startingStripeEquity||0)>0)lots.push({v:p.startingStripeEquity,b:p.startingStripeEquity*(p.stripeStartingBasisPct??1),yr:sy-1});
  let tSNew=0,tSSold=0,tSRet=0,tSHold=0,tSGainTax=0;
  const R=[];
  for(let yr=sy;yr<=ey;yr++){
    const nk=kids.filter(k=>yr>=k).length;
    const yIdx=yr-sy;
    const {cash:normCash,stock:normStock}=normComp(p,yIdx);
    const normW2=normCash+normStock; // identical treatment for tax; split matters for cash
    let nancyGross,nancyIsSolo=false,nancySENet=0,nancyOH=0;
    if(yIdx<4&&yr<p.nancyRampYear){nancyGross=p['nancyW2Y'+yIdx]??100000}
    else{
      nancyIsSolo=p.nancySoloPractice===1;
      const yrsIn=yr-p.nancyRampYear;
      let cl=yrsIn<0?0:yrsIn>=p.nancyRampYears?p.nancyMaxClients:p.nancyRampClients+(p.nancyMaxClients-p.nancyRampClients)*(yrsIn/p.nancyRampYears);
      nancyGross=Math.round(cl*p.nancyHourlyRate*p.nancyWeeksPerYear);
      if(nancyIsSolo){nancyOH=p.nancyPracticeOverhead+(yr>=p.homePurchaseYear?p.nancyHomeOfficeDeduct:0);nancySENet=Math.max(0,nancyGross-nancyOH)}
    }
    const grossIncome=normW2+nancyGross;
    const ctcKids=kids.filter(k=>yr>=k&&(yr-k)<17).length;
    const taxP={...p,_normW2:normW2,_nancyW2:nancyIsSolo?0:nancyGross,_nancySE:nancyIsSolo?nancySENet:0,_nancyOverhead:nancyIsSolo?nancyOH:0};
    const tax=calcTax(grossIncome,taxP,yr,ctcKids);
    // tax.net nets ALL household tax out of ALL comp (cash + stock). Backing the stock
    // straight out leaves exactly the spendable figure:
    //   normCash + nancyGross − taxes − pretax − practice overhead
    // This is equivalent to real sell-to-cover withholding — charging the grant's
    // withholding against cash and receiving the grant gross nets out identically once the
    // resulting shortfall is closed by selling that same stock in the waterfall below.
    // The grant arrives net of withholding; the cash side keeps everything else. Defining
    // cash as the residual means the two always sum to total after-tax compensation, so a
    // change in the withholding rate moves dollars between them and never creates any.
    const vestRate=vestTaxRate(p,tax,taxP,grossIncome,yr,ctcKids,normStock);
    const normStockNet=normStock*(1-vestRate);
    const cashAvail=tax.net-normStockNet;
    const inc=cashAvail;
    // rets[] (Monte Carlo) perturbs only the DIVERSIFIED portfolio. Stripe follows its own
    // explicit return path — we have no basis for claiming to know its volatility.
    const ret=rets?rets[yIdx]:p.investReturn;
    // Half-year convention: prior balance compounds a full year, this year's
    // contributions (deposited throughout the year) earn ~half a year of return.
    k401=k401*(1+ret)+(p.pretax401k+p.company401kMatch)*(1+ret/2);
    const sub=yr>=p.homePurchaseYear;
    // Property tax = rate × current home value (appreciates each year). Falls back
    // to legacy flat propTaxBase/homePrice for saved states without a rate.
    const ptRate=p.propTaxRate??(p.propTaxBase&&p.homePrice?p.propTaxBase/p.homePrice:0.012);
    const homeVal=sub?p.homePrice*(1+p.homeAppreciation)**(yr-p.homePurchaseYear):0;
    const ptax=sub?ptRate*homeVal:0;
    let h=sub?am+ptax+p.maintBase*1.02**(yr-p.homePurchaseYear):p.nycRent*12;
    const inf=(1+p.expenseInflation)**(yr-sy);
    let gr=p.baseGroceries*inf,di=p.baseDining*inf,sh=p.baseShopping*inf,va=(nk>0?p.postKidVacations:p.baseVacations)*inf;
    let au=p.baseAuto*inf,ins=p.baseInsurance*inf,mi=p.baseMisc*inf,en=p.baseEntertainment*inf;
    let ch=p.baseCharity*inf,md=p.baseMedical*inf,tr=p.baseTransit*inf,ut=p.baseUtilsPhoneNet*inf;
    if(sub){au+=p.suburbAutoBoost*inf;ins+=p.suburbInsBoost*inf;ut+=p.suburbUtilBoost*inf;tr*=.4}
    for(const kb of kids){if(yr<kb)continue;const a=yr-kb,c=kidCost(a);gr+=c.g*inf;di+=c.d*inf;sh+=c.s*inf;md+=c.m*inf;mi+=c.x*inf;en+=c.e*inf;va+=c.v*inf}
    const liv=gr+di+sh+va+au+ins+mi+en+ch+md+tr+ut;
    // Childcare — a single flat monthly rate from birth through the year before yeshiva
    // starts (previously modeled 3 separate phases: nanny hourly rate at birth, nanny
    // hourly through a configurable end-age, then daycare-or-continued-nanny depending on
    // birth order — collapsed since the phase distinctions added complexity without
    // changing what actually mattered: a monthly childcare cost until school starts).
    let cc=0;
    for(let ki=0;ki<kids.length;ki++){
      const kb=kids[ki],a=yr-kb;
      const startAge=ki===0?p.kid1YeshivaStartAge:p.yeshivaStartAge;
      if(a>=0&&a<startAge)cc+=(p.childcareMonthly??2800)*12;
    }
    tC+=cc;
    let tu=0;
    for(let ki=0;ki<kids.length;ki++){
      const kb=kids[ki],a=yr-kb;
      const startAge=ki===0?p.kid1YeshivaStartAge:p.yeshivaStartAge;
      if(a>=startAge&&a<=p.yeshivaEndAge)tu+=baseTuit(a)*(1+p.tuitionInflation)**(yr-sy); // C4 fix: yr-sy not yr-2026
    }
    tT+=tu;
    const totE=h+liv+cc+tu;
    const surp=cashAvail-totE; // operating cash flow — retained stock is NOT spendable
    // ── Stripe cash waterfall ──
    // Cash comp funds life first. Whatever it can't cover (including the down payment, a
    // real cash outflow) is the gap the retention policy decides how to close.
    const dpThis=(yr===p.homePurchaseYear)?dp:0;
    const netCash=surp-dpThis;
    const sr=stripeReturn(p,yIdx);
    const gp=1-p.costBasisPct,td=gp*p.capGainsTaxRate;
    // A negative balance is an unfunded shortfall, not a leveraged position. Compounding it
    // at the portfolio's expected return would model an unlimited margin loan accruing at
    // the same rate the portfolio is assumed to earn, so it stays flat instead.
    const liqGrown=liq>0?liq*(1+ret):liq;
    // The waterfall trades the AFTER-TAX grant: withheld shares never reach the account, so
    // they can be neither sold for cash nor retained as equity.
    const stripeSold=Math.max(0,Math.min(normStockNet,stripeSellAmount(p,normStockNet,netCash,liqGrown,ret,td)));
    const stripeRetained=Math.max(0,normStockNet-stripeSold);
    // ── Stripe equity roll-forward, on the tender calendar ──
    // Everything below happens AT the Feb-yr mark. No growth is credited yet: the year's
    // sales have to execute at the price the shares are actually marked at, and this year's
    // return only becomes real at the Feb yr+1 tender, applied after the waterfall.
    const stripeBegin=lotsValue(lots);
    // In the observation year the opening balance was measured part-way through, so the
    // vests that had already landed are inside it. Only the remainder is new equity.
    const vestShareNew=(yr===sy)?stripeVestRemaining(p):1;
    const alreadyInOpening=stripeRetained*(1-vestShareNew);
    const newVest=stripeRetained*vestShareNew;
    // Basis of a vesting lot is its vest-date fair market value, which is the same mark.
    if(newVest>0)lots.push({v:newVest,b:newVest,yr});
    // ── Funding waterfall for whatever this year's vest could not cover ──
    // Diversified pool first, but only down to the reserve floor; then Stripe holdings;
    // and only if those are exhausted too does the pool go below the floor.
    let txS=0,sold=0,holdSold=0,holdTax=0,netFlow=netCash+stripeSold;
    if(netFlow<0){
      let need=-netFlow; // net cash still required after the vest
      const floor=Math.max(0,p.liquidReserveFloor??p.stripeLiquidFloor??500000);
      // Gross sale that lands the pool exactly on the floor, under the same half-year
      // convention applied below. Selling from the pool is grossed up for cap-gains tax.
      const roomToFloor=Math.max(0,(liqGrown-floor)/(1+ret/2));
      const fromLiq=Math.min(need/(1-td),roomToFloor);
      sold=fromLiq;txS=fromLiq*td;need-=fromLiq*(1-td);
      // Selling shares held from a PRIOR year does realise a gain — unlike a vest-date sale,
      // where basis equals the sale price. Only appreciation above basis is taxed.
      if(need>1e-6){
        const r=sellLots(lots,need,p.capGainsTaxRate);
        holdSold=r.gross;holdTax=r.tax;need=r.shortfall;
      }
      // Nothing left to sell: the pool breaches the floor, and can go negative. That is a
      // genuinely insolvent plan, and the UI calls it out rather than hiding it.
      if(need>1e-6){const extra=need/(1-td);sold+=extra;txS+=extra*td;}
      netFlow=-sold; // Stripe proceeds fund expenses directly; they never enter the pool
    }
    // ── The next February tender re-marks whatever is still held ──
    // Everything that survived this year's sales appreciates once, together, because a
    // private position has one price and it moves on one date.
    const stripePreGrowth=lotsValue(lots);
    for(const L of lots)L.v*=(1+sr);
    const stripeAppr=lotsValue(lots)-stripePreGrowth;
    // Half-year convention: prior balance compounds a full year, this year's net
    // flow (surplus, withdrawals, down payment) earns ~half a year of return.
    liq=liqGrown+netFlow*(1+ret/2);tTx+=txS;tS+=sold;
    // Drop emptied lots so the ledger stays small across a 33-year Monte Carlo.
    for(let i=lots.length-1;i>=0;i--)if(lots[i].v<=1e-6)lots.splice(i,1);
    const stripeEnd=lotsValue(lots);
    tSNew+=normStockNet;tSSold+=stripeSold;tSRet+=stripeRetained;
    tSHold+=holdSold;tSGainTax+=holdTax;
    let hv=0,mb=0,eq=0;
    // yo = years of ownership elapsed. 0 in the purchase year itself (just closed,
    // no appreciation/paydown yet) — matches the property-tax calc above and the
    // mortgage-interest amortization in calcTax(), both of which start at 0 elapsed years.
    if(sub){const yo=yr-p.homePurchaseYear;hv=p.homePrice*(1+p.homeAppreciation)**yo;mb=mBal(ma,p.mortgageRate/100,yo);eq=hv-mb}
    const kiy=kids.filter((k,ki)=>{const a=yr-k;const sa=ki===0?p.kid1YeshivaStartAge:p.yeshivaStartAge;return a>=sa&&a<=p.yeshivaEndAge}).length;
    const nw=liq+stripeEnd+eq;
    R.push({yr,normG:Math.round(normW2),normCash:Math.round(normCash),normStock:Math.round(normStock),
      nancyG:Math.round(nancyGross),gross:tax.gross,tax:tax.allInTax,effRate:tax.effRate,
      inc:Math.round(inc),netTC:tax.net,h:Math.round(h),ptax:Math.round(ptax),hv:Math.round(hv),
      liv:Math.round(liv),cc:Math.round(cc),tu:Math.round(tu),totE:Math.round(totE),
      surp:Math.round(surp),
      // `flow` is the household's actual net cash flow: everything earned after tax, minus
      // everything spent. It is the figure that answers "am I living within my income", and
      // it is the one to headline. `surp` answers a narrower question — whether the CASH
      // half of the package alone covers the year — and with a stock-heavy grant that is
      // negative almost every year even when the household is comfortably ahead. Leading
      // with surp reads as a deficit that does not exist.
      flow:Math.round(tax.net-totE),
      // Two different questions, and reporting only one of them was misleading.
      //   gap    — shortfall against CASH pay alone. Says how much of the year's vest has to
      //            be sold. Closing it consumes no accumulated wealth.
      //   incGap — what is still short after selling EVERY vesting share. This is the one
      //            that actually eats into savings or previously held Stripe.
      // incGap is always <= gap, and the two differ by exactly that year's grant.
      gap:Math.round(Math.max(0,-surp)),
      incGap:Math.round(Math.max(0,totE-tax.net)),
      // Total cash the funding waterfall must source, including the down payment — a capital
      // outflow, not an operating shortfall, which is why it is kept separate from both gaps.
      need:Math.round(Math.max(0,-netCash)),dpOut:Math.round(dpThis),
      txS:Math.round(txS),sold:Math.round(sold),liq:Math.round(liq),eq:Math.round(eq),
      // sNew is the AFTER-TAX grant — what actually reaches the account — so it is directly
      // comparable to sBeg, which is an after-tax balance. sGross and sVestTax show the
      // withholding that separates them rather than leaving the reader to wonder why the
      // grant on the offer letter and the shares in the portal disagree.
      sBeg:Math.round(stripeBegin),sNew:Math.round(normStockNet),
      sGross:Math.round(normStock),sVestTax:Math.round(normStock-normStockNet),
      sVestRate:vestRate,sSold:Math.round(stripeSold),
      // Derived from the two rounded figures rather than rounded independently, so the
      // reported sold + retained always adds back to the reported vest (post-window comp
      // is fractional, and three separate roundings can otherwise drift a dollar apart).
      sRet:Math.round(normStockNet)-Math.round(stripeSold),
      // What actually ENTERED the equity ledger this year, versus what the opening balance
      // was already carrying. These differ only in the observation year, and stating both is
      // the difference between a reconcilable dashboard and one that appears to double-count.
      sAdded:Math.round(newVest),sInOpening:Math.round(alreadyInOpening),
      sHold:Math.round(holdSold),sGainTax:Math.round(holdTax),
      sAppr:Math.round(stripeAppr),sEnd:Math.round(stripeEnd),
      sBasis:Math.round(lotsBasis(lots)),sLots:lots.length,sRate:sr,sPct:nw>0?stripeEnd/nw:0,
      nw:Math.round(nw),k401:Math.round(k401),kiy,nk});
  }
  // Years the plan actually reaches for savings. `surp<0` is NOT this: with a stock-heavy
  // package, cash comp alone rarely covers a year, so surp is negative almost always even
  // when that year's vest closes the gap entirely and nothing is liquidated. Counting surp
  // reads as "33 deficit years, drawing down savings heavily" for a plan that never touches
  // the portfolio — the distinction the cash/stock split exists to make.
  return{R,drawYears:drawYears(R),tT:Math.round(tT),tC:Math.round(tC),tTx:Math.round(tTx),tS:Math.round(tS),am,dp,mm:am/12,
    vestOnlyYears:R.filter(r=>r.surp<0&&r.sold===0&&r.sHold===0).length,
    tSNew:Math.round(tSNew),tSSold:Math.round(tSSold),tSRet:Math.round(tSRet),
    tSHold:Math.round(tSHold),tSGainTax:Math.round(tSGainTax),
    stripeEnd:Math.round(lotsValue(lots)),stripeBasis:Math.round(lotsBasis(lots)),
    stripeAppr:Math.round(lotsValue(lots)-lotsBasis(lots))};
}

// ── One-time and recurring costs of buying ─────────────────────────────────
// The affordability maths previously counted only the down payment and the carrying cost of
// principal, interest, tax and maintenance. A New York purchase carries several thousand to
// six figures of costs beyond that, and they land as CASH at closing — precisely when
// reserves are thinnest.
//
// Rates below are the statutory New York City ones, which are formulaic rather than guessed:
// mansion tax bands from 1% at $1M, mortgage recording tax on loans over $500K, plus title
// and legal. Every one is overridable, and each is stated so the total can be checked.
// [upper bound, rate] — the rate applies from the previous bound up to (not including) this
// one. $1M–$2M is 1.00%, $2M–$3M is 1.25%, and so on. Getting the alignment wrong overcharges
// an entire band, which a test caught: a $1.5M purchase is 1.00%, not 1.25%.
const NYC_MANSION_BANDS=[[2e6,.01],[3e6,.0125],[5e6,.015],[10e6,.0225],[15e6,.0325],[20e6,.035],[25e6,.0375],[Infinity,.039]];
function mansionTax(price,p){
  if(p&&p.mansionTaxRate!=null)return price*Number(p.mansionTaxRate);
  if(price<1e6)return 0;
  for(const [top,rate] of NYC_MANSION_BANDS)if(price<top)return price*rate;
  return price*0.039;
}
function closingCosts(price,p){
  const loan=price*(1-(p.downPctg||0)/100);
  const mansion=mansionTax(price,p);
  // NYC mortgage recording tax: 1.925% on loans of $500K+, 1.8% below. Buyer-paid.
  const recording=loan>0?loan*(loan>=5e5?0.01925:0.018):0;
  const titleRate=p.titleInsuranceRate!=null?Number(p.titleInsuranceRate):0.0045;
  const title=price*titleRate;
  const legal=p.closingLegalFees!=null?Number(p.closingLegalFees):5000;
  const other=p.closingOtherFees!=null?Number(p.closingOtherFees):3500; // inspection, appraisal, recording
  const total=mansion+recording+title+legal+other;
  return{mansion,recording,title,legal,other,total,pctOfPrice:price>0?total/price:0};
}
// Cash needed at the table: deposit plus every one-time cost of getting in.
function cashToClose(price,p){
  const down=price*((p.downPctg||0)/100);
  const cc=closingCosts(price,p);
  const moving=p.movingCosts!=null?Number(p.movingCosts):12000;
  return{down,closing:cc.total,moving,total:down+cc.total+moving,breakdown:cc};
}
// Annual carrying cost per $1 of price now includes insurance, which is a real recurring
// obligation the ratio test previously ignored.
function insuranceFor(price,p){
  if(p.homeInsuranceAnnual!=null)return Number(p.homeInsuranceAnnual);
  const rate=p.homeInsuranceRate!=null?Number(p.homeInsuranceRate):0.0035;
  return price*rate;
}

// ── Affordability ──────────────────────────────────────────────────────────
// Two independent limits, because "what can I afford" has two honest answers and they bind
// under different conditions.
//
//  planLimit    — the most expensive house where the plan still HOLDS: the diversified pool
//                 never breaks its reserve floor across the whole horizon. This runs the real
//                 waterfall, so it already accounts for Stripe funding the down payment, the
//                 capital gains that forced sales realise, tuition, everything.
//  comfortLimit — the most expensive house whose all-in carrying cost stays within a target
//                 share of after-tax income in the purchase year. The classic ratio test.
//
// Neither dominates. A big balance sheet with thin cash flow is comfort-limited; strong cash
// flow with little saved is plan-limited. Reporting only one hides the constraint that binds.

// Annual all-in housing cost per $1 of purchase price, holding down %, rate and tax rate
// fixed. Every component is proportional to price, which is what makes the ratio test a
// division rather than a search.
function housingCostPerDollar(p){
  const loanFrac=1-(p.downPctg||0)/100;
  const mr=(p.mortgageRate||0)/100/12;
  const piPerDollar=mr>0
    ? loanFrac*(mr*(1+mr)**360)/((1+mr)**360-1)*12
    : loanFrac/30; // 0% mortgage: straight amortisation over the term
  const maintPerDollar=p.homePrice>0?(p.maintBase||0)/p.homePrice:0;
  // Insurance scales with the insured value, so it belongs in the per-dollar rate rather
  // than being bolted on afterwards — leaving it out overstated affordability.
  const insPerDollar=p.homeInsuranceAnnual!=null
    ?(p.homePrice>0?Number(p.homeInsuranceAnnual)/p.homePrice:0)
    :(p.homeInsuranceRate!=null?Number(p.homeInsuranceRate):0.0035);
  return piPerDollar+(p.propTaxRate??0.012)+maintPerDollar+insPerDollar;
}

function comfortAffordablePrice(p,targetShare,R){
  const rows=R||run(p).R;
  const row=rows.find(r=>r.yr===p.homePurchaseYear)||rows[rows.length-1];
  const perDollar=housingCostPerDollar(p);
  if(!(perDollar>0))return 0;
  // netTC is total after-tax comp: vesting stock is sellable at vest for no extra tax, so it
  // funds a mortgage payment like any other dollar.
  return Math.max(0,row.netTC*targetShare/perDollar);
}

// Feasibility is monotone in price — a more expensive house is never easier to fund — so
// bisection converges exactly to the step size.
function planAffordablePrice(p,opts){
  const o=opts||{};
  const floor=Math.max(0,p.liquidReserveFloor??500000);
  const step=o.step||10000;
  let lo=o.lo||100000,hi=o.hi||8000000;
  const holds=price=>{
    try{return run({...p,homePrice:price}).R.every(r=>r.liq>=floor-1)}
    catch(e){return false}
  };
  if(!holds(lo))return 0;
  if(holds(hi))return hi;
  while(hi-lo>step){const mid=(lo+hi)/2;if(holds(mid))lo=mid;else hi=mid}
  return Math.floor(lo/step)*step;
}

function affordability(p,targetShare,R){
  const plan=planAffordablePrice(p);
  const comfort=comfortAffordablePrice(p,targetShare??0.28,R);
  const max=Math.min(plan,comfort);
  return{plan,comfort,max,binding:plan<=comfort?'plan':'comfort',
    current:p.homePrice,withinBudget:p.homePrice<=max};
}

function randNorm(mean,sd){
  let u=0,v=0;while(u===0)u=Math.random();while(v===0)v=Math.random();
  return mean+sd*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}

// ── Historical S&P 500 total annual returns (dividends included), 1928–2023 ──
// Approximate, widely-cited figures used only for the optional "historical bootstrap"
// Monte Carlo mode — illustrative of real sequences (crashes, recoveries, boom years),
// not represented as precise to the decimal or audited against a canonical source.
const HIST_SP500_RETURNS=[
  .438,-.083,-.251,-.438,-.086,.500,-.012,.477,.339,-.353,.311,-.004,-.098,-.116,.203,.259,
  .197,.364,-.081,.057,.055,.188,.317,.240,.184,-.010,.526,.316,.066,-.108,.434,.120,.005,
  .269,-.087,.228,.165,.125,-.101,.240,.111,-.085,.040,.143,.190,-.147,-.265,.372,.238,-.072,
  .066,.184,.324,-.049,.214,.225,.063,.322,.185,.058,.165,.317,-.031,.305,.076,.101,.013,
  .376,.230,.334,.286,.210,-.091,-.119,-.221,.287,.109,.049,.158,.055,-.370,.265,.151,.021,
  .160,.324,.137,.014,.120,.218,-.044,.315,.184,.287,-.181,.263
];
// Block bootstrap: draw a random contiguous run from real history (wrapping if the plan
// horizon exceeds the dataset) so autocorrelation/sequence-of-returns risk is preserved,
// unlike i.i.d. draws which understate how real bad decades cluster.
function drawHistoricalBlock(nYears){
  const H=HIST_SP500_RETURNS,n=H.length;
  const startIdx=Math.floor(Math.random()*n);
  const out=[];
  for(let i=0;i<nYears;i++)out.push(H[(startIdx+i)%n]);
  return out;
}

function runMonteCarlo(p,trials=600,mode='lognormal'){
  const sy=p.planStartYear||2026;const ey=p.planEndYear||2058;const nYears=ey-sy+1;
  const vol=p.mcVol??.14;const mean=p.investReturn;
  // Lognormal returns: treat `mean` as the ARITHMETIC expected return and derive the
  // log-drift so the simulated geometric mean is correct (drift = ln(1+mean) − vol²/2).
  // A 1+r ~ lognormal draw can never fall below −100% and has a realistic fat right tail,
  // unlike the previous additive-normal draws which understated crash frequency and
  // overstated compounding (E[normal] = arithmetic mean ignores volatility drag).
  const logDrift=Math.log(1+mean)-0.5*vol*vol;
  const drawRet=()=>Math.exp(randNorm(logDrift,vol))-1;
  const isHist=mode==='historical';
  const geomMean=isHist
    ? HIST_SP500_RETURNS.reduce((a,b)=>a*(1+b),1)**(1/HIST_SP500_RETURNS.length)-1
    : Math.exp(logDrift)-1; // expected compounded annual growth
  const nwPaths=[],liqPaths=[],finalNW=[],floorLiq=[];let ruin=0,dpFail=0;
  const dpYr=p.homePurchaseYear,dpNeed=p.homePrice*(p.downPctg/100),dpIdx=dpYr-sy;
  for(let t=0;t<trials;t++){
    const rets=isHist?drawHistoricalBlock(nYears):Array.from({length:nYears},drawRet);
    const{R}=run(p,rets);
    nwPaths.push(R.map(r=>r.nw));liqPaths.push(R.map(r=>r.liq));
    finalNW.push(R[R.length-1].nw);
    const minLiq=Math.min(...R.map(r=>r.liq));floorLiq.push(minLiq);
    if(minLiq<0)ruin++;
    // Sequence-of-returns risk: probability the liquid pool can't cover the down
    // payment in the purchase year (measured at the prior year-end, before the outflow).
    if(dpIdx>=1&&dpIdx<R.length&&R[dpIdx-1].liq<dpNeed)dpFail++;
  }
  const pct=(arr,q)=>{const s=[...arr].sort((a,b)=>a-b);const idx=(s.length-1)*q;const lo=Math.floor(idx),hi=Math.ceil(idx);return s[lo]+(s[hi]-s[lo])*(idx-lo)};
  const band={p10:[],p50:[],p90:[]};
  for(let y=0;y<nYears;y++){
    const col=nwPaths.map(path=>path[y]);
    band.p10.push(pct(col,.10));band.p50.push(pct(col,.50));band.p90.push(pct(col,.90));
  }
  finalNW.sort((a,b)=>a-b);
  return{band,trials,vol,geomMean,mode,
    finalP10:pct(finalNW,.10),finalP50:pct(finalNW,.50),finalP90:pct(finalNW,.90),
    ruinPct:ruin/trials*100,
    dpFailPct:dpIdx>=1?dpFail/trials*100:null,
    liqFloorP10:pct(floorLiq,.10)};
}

// Export for Node (tests) — noop in browser
if(typeof module!=='undefined'&&module.exports){
  module.exports={bracketTax,calcTax,run,runMonteCarlo,baseTuit,kidCost,mPmt,mBal,
    normComp,stripeReturn,stripeVestFactor,stripeVestRemaining,STRIPE_VEST_MONTHS,stripeSellAmount,sellLots,lotsValue,lotsBasis,drawYears,
    housingCostPerDollar,comfortAffordablePrice,planAffordablePrice,affordability,
    mansionTax,closingCosts,cashToClose,insuranceFor,NYC_MANSION_BANDS,
    NORM_COMP_YEARS,STRIPE_RET_YEARS,
    FED_BR_2026,NYS_BR_2026,NYC_BR_2026,SS_CAP_2026,SALT_BASE_2026,STD_DEDUCT_2026,
    HIST_SP500_RETURNS};
}
