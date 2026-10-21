'use strict';
// An immutable overlay and analysis of the existing engine, never a second projection model.
(function(root){
 const copy=x=>JSON.parse(JSON.stringify(x));
 const bounded=(v,d,lo,hi)=>Number.isFinite(Number(v))?Math.max(lo,Math.min(hi,Number(v))):d;
 function config(p,c={}){
  const sy=p.planStartYear||2026;
  const history=h=>Object.fromEntries(Object.entries(h||{}).filter(([y,v])=>Number.isInteger(+y)&&+y>=1900&&+y<sy&&Number.isFinite(Number(v))&&Number(v)>=0).map(([y,v])=>[y,Number(v)]));
  const n=Math.round(bounded(c.normBirthYear,1993,sy-80,sy-18)),a=Math.round(bounded(c.nancyBirthYear,1993,sy-80,sy-18));
  return {...c,enabled:c.enabled!==false,transitionYear:Math.round(bounded(c.transitionYear,2034,sy+1,Math.max(sy+1,n+Math.round(bounded(c.normStopAge,65,35,90))))),normBirthYear:n,nancyBirthYear:a,
   horizonAge:Math.round(bounded(c.horizonAge,90,90,100)),normIncome:bounded(c.normIncome,150000,0,5e6),nancyIncome:bounded(c.nancyIncome,200000,0,5e6),
   normGrowth:bounded(c.normGrowth,.02,-.1,.15),nancyGrowth:bounded(c.nancyGrowth,.02,-.1,.15),normType:c.normType==='consulting'?'consulting':'w2',
   normStopAge:Math.round(bounded(c.normStopAge,65,35,90)),nancyStopAge:Math.round(bounded(c.nancyStopAge,65,35,90)),reserve:bounded(c.reserve,p.liquidReserveFloor??500000,0,1e7),maxWithdrawal:bounded(c.maxWithdrawal,.04,.005,.25),
   extraHealth:bounded(c.extraHealth,0,0,200000),contribution:bounded(c.contribution,0,0,100000),consultingOverhead:bounded(c.consultingOverhead,0,0,1e6),
   normNySource:bounded(c.normNySource,p.locationConfig?.normNySource??1,0,1),practiceNySource:bounded(c.practiceNySource,p.locationConfig?.practiceNySource??0,0,1),
   stress:['base','downturn','earnings25','earnings50','early'].includes(c.stress)?c.stress:'base',ssLevel:[0,.75,1].includes(Number(c.ssLevel))?Number(c.ssLevel):1,
   ssCola:bounded(c.ssCola,p.expenseInflation??.025,0,.1),ssWageGrowth:bounded(c.ssWageGrowth,p.taxInflation??.025,0,.1),
   normClaimAge:Math.round(bounded(c.normClaimAge,67,62,70)),nancyClaimAge:Math.round(bounded(c.nancyClaimAge,67,62,70)),
   normSSMonthly:bounded(c.normSSMonthly,0,0,20000),nancySSMonthly:bounded(c.nancySSMonthly,0,0,20000),
   normEarningsHistory:history(c.normEarningsHistory),nancyEarningsHistory:history(c.nancyEarningsHistory),
   normLateIncome:bounded(c.normLateIncome,0,0,5e6),nancyLateIncome:bounded(c.nancyLateIncome,0,0,5e6),
   normLateStart:Math.round(bounded(c.normLateStart,65,65,100)),nancyLateStart:Math.round(bounded(c.nancyLateStart,65,65,100)),
   normLateEnd:Math.max(Math.round(bounded(c.normLateStart,65,65,100)),Math.round(bounded(c.normLateEnd,70,65,100))),nancyLateEnd:Math.max(Math.round(bounded(c.nancyLateStart,65,65,100)),Math.round(bounded(c.nancyLateEnd,70,65,100))),
   normLateGrowth:bounded(c.normLateGrowth,.02,-.1,.15),nancyLateGrowth:bounded(c.nancyLateGrowth,.02,-.1,.15),
   normDeathAge:Math.round(bounded(c.normDeathAge,110,67,110)),nancyDeathAge:Math.round(bounded(c.nancyDeathAge,110,67,110)),
   healthInflation:bounded(c.healthInflation,p.expenseInflation??.025,0,.15),
   medicareOther:bounded(c.medicareOther,0,0,100000),medicareCredit:bounded(c.medicareCredit,0,0,100000),
   vests:c.vests||{}};
 }
 function horizon(c){return Math.max(c.normBirthYear,c.nancyBirthYear)+c.horizonAge;}
 function prepare(p,run){
  const c=config(p,p.fiConfig),clean=copy(p);delete clean.fiConfig;delete clean._fiPrepared;delete clean._fiExpenses;
  clean.planEndYear=horizon(c);
  // Freeze every consumption line, including income-linked budget rules. Retirement saving
  // and incremental replacement health coverage are explicit separate decisions.
  const base=run(clean).R;
  return {...clean,fiConfig:c,_fiPrepared:true,_fiExpenses:Object.fromEntries(base.map(r=>[r.yr,{h:r.hFull,liv:r.livFullParts,cc:r.ccFull,tu:r.tuFull,oneoff:r.eAdj}]))};
 }
 function afterTaxStripe(r,p){return Math.max(0,r.sEnd-(Math.max(0,r.sEnd-r.sBasis)*(r.capGainsRate??p.capGainsTaxRate??.35)));}
 function accessible(r,p,c){return r.liq+afterTaxStripe(r,p)+(r.yr-c.normBirthYear>=60?r.k401:0)-Math.abs(p.otherDebt||0);}
 function summary(result,p,c){
  const R=result.R.filter(r=>r.yr>=c.transitionYear),opening=result.R.find(r=>r.yr===c.transitionYear-1);
  const stats=R.map((r,i)=>{const prev=i?R[i-1]:opening;const available=(prev?accessible({...prev,yr:r.yr},p,c):0)+(!i?Math.max(0,p._fiExtraCapital||0):0);
   const withdrawal=Math.max(0,r.fiFundingNeed||0)+Number(r.txS||0)+Number(r.sGainTax||0)+Number(r.fiRetTax||0)+Number(r.fiSSGainTax||0);
   return {yr:r.yr,available,withdrawal,rate:withdrawal>0?(available>0?withdrawal/available:Infinity):0};});
  const fail=result.R.find(r=>r.liq<0||!Number.isFinite(r.netWorth));
  const breach=R.find(r=>r.liq+1<c.reserve*(1+(p.expenseInflation||0))**(r.yr-(p.planStartYear||2026)));
  const excess=stats.find(r=>r.rate>c.maxWithdrawal);
  const status=fail?'Unsustainable':breach||excess?'Borderline':'Sustainable under assumptions';
  const low=R.reduce((a,b)=>accessible(b,p,c)<accessible(a,p,c)?b:a,R[0]);
  const deflate=r=>(1+(p.expenseInflation||0))**(r.yr-(p.planStartYear||2026));
  const realLow=R.reduce((a,b)=>accessible(b,p,c)/deflate(b)<accessible(a,p,c)/deflate(a)?b:a,R[0]);
  const portfolio=r=>r.liq+afterTaxStripe(r,p)+r.k401;
  const portfolioLow=R.reduce((a,b)=>portfolio(b)<portfolio(a)?b:a,R[0]);
  const portfolioRealLow=R.reduce((a,b)=>portfolio(b)/deflate(b)<portfolio(a)/deflate(a)?b:a,R[0]);
  return {minReal:accessible(realLow,p,c)/deflate(realLow),minRealYear:realLow.yr,portfolioMin:portfolio(portfolioLow),portfolioMinYear:portfolioLow.yr,portfolioMinReal:portfolio(portfolioRealLow)/deflate(portfolioRealLow),portfolioMinRealYear:portfolioRealLow.yr,status,failYear:fail?.yr??null,reserveYear:breach?.yr??null,rateYear:excess?.yr??null,peakRate:Math.max(0,...stats.filter(r=>Number.isFinite(r.rate)).map(r=>r.rate)),stats,
   opening,transition:R[0],min:accessible(low,p,c),minYear:low.yr,final:R.at(-1),drawYears:stats.filter(r=>r.withdrawal>0).length,
   milestones:[60,65,70,75,80,85,90].map(age=>({age,row:result.R.find(r=>r.yr===c.normBirthYear+age)}))};
 }
 function analyze(p,input,M,{scan=true,stresses=true}={}){
  const c=config(p,input),plan=prepare({...p,fiConfig:c},M.run),base=copy(plan);delete base.fiConfig;delete base._fiExpenses;delete base._fiPrepared;
  const original=M.run(p.fiConfig?.enabled?p:base),result=M.run(plan),s=summary(result,plan,c);
  const solve=(changes={},extra=0)=>{const q={...plan,_fiExtraCapital:extra,fiConfig:{...c,...changes}};const result=M.run(q);return {result,...summary(result,q,q.fiConfig)};};
  const search=level=>{
   const candidates=[];
   if(scan){const end=Math.min(horizon(c)-1,c.normBirthYear+c.normStopAge);
    for(let year=(p.planStartYear||2026)+1;year<=end;year++){
     const t=solve({ssLevel:level,transitionYear:year});candidates.push({year,status:t.status,min:t.min,failYear:t.failYear,peakRate:t.peakRate,endInvestments:t.final.liq+afterTaxStripe(t.final,p)+t.final.k401});
    }}
   return {candidates,earliest:candidates.find(x=>x.status==='Sustainable under assumptions')?.year??null,solvent:candidates.find(x=>x.status!=='Unsustainable')?.year??null};
  };
  const ssComparisons=[0,.75,1].map(level=>{
   const t=level===c.ssLevel?{result,...s}:solve({ssLevel:level});
   let additionalCapital=null,fundingCapital=null;
   if(scan){
    const passes=capital=>solve({ssLevel:level},capital).status==='Sustainable under assumptions';
    if(t.status==='Sustainable under assumptions')additionalCapital=0;
    else{let lo=0,hi=1e8;if(passes(hi)){for(let i=0;i<18;i++){const mid=(lo+hi)/2;if(passes(mid))hi=mid;else lo=mid;}additionalCapital=Math.ceil(hi/1000)*1000;}}
   }
   if(scan){
    const passes=capital=>solve({ssLevel:level},capital).failYear===null;
    if(!t.failYear)fundingCapital=0;
    else{let lo=0,hi=1e8;if(passes(hi)){for(let i=0;i<18;i++){const mid=(lo+hi)/2;if(passes(mid))hi=mid;else lo=mid;}fundingCapital=Math.ceil(hi/1000)*1000;}}
   }
   return {level,...t,...search(level),additionalCapital,fundingCapital};
  });
  const selected=ssComparisons.find(x=>x.level===c.ssLevel),{candidates,earliest,solvent}=selected;
  const stressResults=stresses?['base','downturn','earnings25','earnings50','early'].map(stress=>({stress,...solve({stress})})):[];
  let requiredNorm=null;
  if(scan&&s.status!=='Sustainable under assumptions'){
   let lo=c.normIncome,hi=2000000;
   const passes=income=>{const q={...plan,fiConfig:{...c,normIncome:income}};return summary(M.run(q),q,q.fiConfig).status==='Sustainable under assumptions';};
   if(passes(hi)){for(let i=0;i<18;i++){const mid=(lo+hi)/2;if(passes(mid))hi=mid;else lo=mid;}requiredNorm=Math.ceil(hi/1000)*1000;}
  }
  let requiredLateIncome=null,fundingLateIncome=null;
  if(scan&&s.status!=='Sustainable under assumptions'){
   const passes=income=>solve({normLateIncome:income,normLateStart:65,normLateEnd:75}).status==='Sustainable under assumptions';
   let lo=0,hi=1e6;if(passes(hi)){for(let i=0;i<16;i++){const mid=(lo+hi)/2;if(passes(mid))hi=mid;else lo=mid;}requiredLateIncome=Math.ceil(hi/1000)*1000;}
  }
  if(scan){
   const passes=income=>solve({normLateIncome:income,normLateStart:65,normLateEnd:75}).failYear===null;
   if(!s.failYear)fundingLateIncome=0;
   else{let lo=0,hi=1e6;if(passes(hi)){for(let i=0;i<16;i++){const mid=(lo+hi)/2;if(passes(mid))hi=mid;else lo=mid;}fundingLateIncome=Math.ceil(hi/1000)*1000;}}
  }
  return {c,plan,original,result,...s,candidates,earliest,solvent,requiredNorm,requiredLateIncome,fundingLateIncome,stressResults,ssComparisons};
 }
 const api={config,horizon,prepare,accessible,afterTaxStripe,summary,analyze};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PlannerFI=api;
})(typeof window!=='undefined'?window:globalThis);
