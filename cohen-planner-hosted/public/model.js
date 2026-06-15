'use strict';
// ═══ COHEN FAMILY FINANCIAL PLANNER — PURE ENGINE ═══
// Shared by browser (loaded via <script>) and Node (require'd by tests).
// No DOM dependencies. No global state.

// ── 2026 base tax constants (MFJ, OBBBA rules) ──
const FED_BR_2026=[[24800,.10],[100800,.12],[211400,.22],[403550,.24],[512450,.32],[731200,.35],[1e15,.37]];
const NYS_BR_2026=[[17150,.04],[23600,.045],[27900,.0525],[161550,.0585],[323200,.0625],[2155350,.0685],[5e6,.0965],[25e6,.103],[1e15,.109]];
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
  const NYS_BR=_scaleBr(NYS_BR_2026,f);
  const NYC_BR=_scaleBr(NYC_BR_2026,f);
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
    const qbiPhaseBase=383900*f; // also index QBI phaseout thresholds
    const qbiPhaseTop=483900*f;
    if(agi<qbiPhaseBase)qbi=qbiBase;
    else if(agi<qbiPhaseTop)qbi=qbiBase*(1-(agi-qbiPhaseBase)/100000);
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

function run(p,rets){
  const sy=p.planStartYear||2026;
  const ey=p.planEndYear||2058;
  const baseYr=sy+4;
  const kids=[p.kid1Birth];
  if(p.numKids>=2)kids.push(p.kid2Birth);
  if(p.numKids>=3)kids.push(p.kid3Birth);
  if(p.numKids>=4)kids.push(p.kid4Birth);
  const dp=p.homePrice*(p.downPctg/100),ma=p.homePrice-dp,am=mPmt(ma,p.mortgageRate/100);
  let liq=p.startingLiquid,k401=p.k401Start||210000,tT=0,tC=0,tTx=0,tS=0;
  const R=[];
  for(let yr=sy;yr<=ey;yr++){
    const nk=kids.filter(k=>yr>=k).length;
    const yIdx=yr-sy;
    let normCash,normStock;
    if(yIdx<4){normCash=p['normCashY'+yIdx]??p.normCashBase;normStock=p['normStockY'+yIdx]??p.normStockBase}
    else{normCash=(p.normCashBase??275000)*(1+p.normGrowth)**(yr-baseYr);normStock=p.normStockBase??150000}
    const normW2=normCash+normStock;
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
    const inc=tax.net;
    const ret=rets?rets[yIdx]:p.investReturn;
    k401+=p.pretax401k+p.company401kMatch;k401*=(1+ret);
    const sub=yr>=p.homePurchaseYear;
    let h=sub?am+p.propTaxBase*1.02**(yr-p.homePurchaseYear)+p.maintBase*1.02**(yr-p.homePurchaseYear):p.nycRent*12;
    const inf=(1+p.expenseInflation)**(yr-sy);
    let gr=p.baseGroceries*inf,di=p.baseDining*inf,sh=p.baseShopping*inf,va=(nk>0?p.postKidVacations:p.baseVacations)*inf;
    let au=p.baseAuto*inf,ins=p.baseInsurance*inf,mi=p.baseMisc*inf,en=p.baseEntertainment*inf;
    let ch=p.baseCharity*inf,md=p.baseMedical*inf,tr=p.baseTransit*inf,ut=p.baseUtilsPhoneNet*inf;
    if(sub){au+=p.suburbAutoBoost*inf;ins+=p.suburbInsBoost*inf;ut+=p.suburbUtilBoost*inf;tr*=.4}
    for(const kb of kids){if(yr<kb)continue;const a=yr-kb,c=kidCost(a);gr+=c.g*inf;di+=c.d*inf;sh+=c.s*inf;md+=c.m*inf;mi+=c.x*inf;en+=c.e*inf;va+=c.v*inf}
    const liv=gr+di+sh+va+au+ins+mi+en+ch+md+tr+ut;
    let cc=0;
    for(let ki=0;ki<kids.length;ki++){
      const kb=kids[ki],am2=(yr-kb)*12,ne=p.nannyEndAge*12;
      const startAge=ki===0?p.kid1YeshivaStartAge:p.yeshivaStartAge;
      const ys=startAge*12;
      if(yr===kb)cc+=p.nannyHourlyRate*9*p.nannyDaysPerWeek*26;
      else if(am2>0&&am2<=ne)cc+=p.nannyHourlyRate*9*p.nannyDaysPerWeek*52;
      else if(am2>ne&&am2<ys&&ki===0)cc+=p.daycareMonthly*12;
      else if(am2>ne&&am2<ys&&ki>0)cc+=p.nannyHourlyRate*9*p.nannyDaysPerWeek*52;
    }
    tC+=cc;
    let tu=0;
    for(let ki=0;ki<kids.length;ki++){
      const kb=kids[ki],a=yr-kb;
      const startAge=ki===0?p.kid1YeshivaStartAge:p.yeshivaStartAge;
      if(a>=startAge&&a<=p.yeshivaEndAge)tu+=baseTuit(a)*(1+p.tuitionInflation)**(yr-sy); // C4 fix: yr-sy not yr-2026
    }
    tT+=tu;
    const totE=h+liv+cc+tu,surp=inc-totE;
    if(yr===p.homePurchaseYear)liq-=dp;
    let txS=0,sold=0;
    if(surp>=0){liq+=surp}else{const def=Math.abs(surp),gp=1-p.costBasisPct,td=gp*p.capGainsTaxRate,gs=def/(1-td);txS=gs-def;sold=gs;liq-=gs}
    liq*=(1+ret);tTx+=txS;tS+=sold;
    let hv=0,mb=0,eq=0;
    if(sub){const yo=yr-p.homePurchaseYear+1;hv=p.homePrice*(1+p.homeAppreciation)**yo;mb=mBal(ma,p.mortgageRate/100,yo);eq=hv-mb}
    const kiy=kids.filter((k,ki)=>{const a=yr-k;const sa=ki===0?p.kid1YeshivaStartAge:p.yeshivaStartAge;return a>=sa&&a<=p.yeshivaEndAge}).length;
    R.push({yr,normG:Math.round(normW2),nancyG:Math.round(nancyGross),gross:tax.gross,tax:tax.allInTax,effRate:tax.effRate,inc,h:Math.round(h),liv:Math.round(liv),cc:Math.round(cc),tu:Math.round(tu),totE:Math.round(totE),surp:Math.round(surp),txS:Math.round(txS),sold:Math.round(sold),liq:Math.round(liq),eq:Math.round(eq),nw:Math.round(liq+eq),k401:Math.round(k401),kiy,nk});
  }
  return{R,tT:Math.round(tT),tC:Math.round(tC),tTx:Math.round(tTx),tS:Math.round(tS),am,dp,mm:am/12};
}

function randNorm(mean,sd){
  let u=0,v=0;while(u===0)u=Math.random();while(v===0)v=Math.random();
  return mean+sd*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}

function runMonteCarlo(p,trials=600){
  const sy=p.planStartYear||2026;const ey=p.planEndYear||2058;const nYears=ey-sy+1;
  const vol=p.mcVol??.14;const mean=p.investReturn;
  const nwPaths=[],liqPaths=[],finalNW=[],floorLiq=[];let ruin=0;
  for(let t=0;t<trials;t++){
    const rets=[];for(let i=0;i<nYears;i++)rets.push(Math.max(-.6,randNorm(mean,vol)));
    const{R}=run(p,rets);
    nwPaths.push(R.map(r=>r.nw));liqPaths.push(R.map(r=>r.liq));
    finalNW.push(R[R.length-1].nw);
    const minLiq=Math.min(...R.map(r=>r.liq));floorLiq.push(minLiq);
    if(minLiq<0)ruin++;
  }
  const pct=(arr,q)=>{const s=[...arr].sort((a,b)=>a-b);const idx=(s.length-1)*q;const lo=Math.floor(idx),hi=Math.ceil(idx);return s[lo]+(s[hi]-s[lo])*(idx-lo)};
  const band={p10:[],p50:[],p90:[]};
  for(let y=0;y<nYears;y++){
    const col=nwPaths.map(path=>path[y]);
    band.p10.push(pct(col,.10));band.p50.push(pct(col,.50));band.p90.push(pct(col,.90));
  }
  finalNW.sort((a,b)=>a-b);
  return{band,trials,vol,
    finalP10:pct(finalNW,.10),finalP50:pct(finalNW,.50),finalP90:pct(finalNW,.90),
    ruinPct:ruin/trials*100,
    liqFloorP10:pct(floorLiq,.10)};
}

// Export for Node (tests) — noop in browser
if(typeof module!=='undefined'&&module.exports){
  module.exports={bracketTax,calcTax,run,runMonteCarlo,baseTuit,kidCost,mPmt,mBal,
    FED_BR_2026,NYS_BR_2026,NYC_BR_2026,SS_CAP_2026,SALT_BASE_2026,STD_DEDUCT_2026};
}
