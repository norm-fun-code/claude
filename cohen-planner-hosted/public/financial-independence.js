'use strict';
// An immutable overlay and analysis of the existing engine, never a second projection model.
(function(root){
 const copy=x=>JSON.parse(JSON.stringify(x));
 const bounded=(v,d,lo,hi)=>Number.isFinite(Number(v))?Math.max(lo,Math.min(hi,Number(v))):d;
 function config(p,c={}){
  const sy=p.planStartYear||2026;
  const n=bounded(c.normBirthYear,1993,sy-80,sy-18),a=bounded(c.nancyBirthYear,1993,sy-80,sy-18);
  return {...c,enabled:c.enabled!==false,transitionYear:Math.round(bounded(c.transitionYear,2034,sy+1,Math.max(n,a)+89)),normBirthYear:n,nancyBirthYear:a,
   horizonAge:Math.round(bounded(c.horizonAge,90,90,100)),normIncome:bounded(c.normIncome,150000,0,5e6),nancyIncome:bounded(c.nancyIncome,200000,0,5e6),
   normGrowth:bounded(c.normGrowth,.02,-.1,.15),nancyGrowth:bounded(c.nancyGrowth,.02,-.1,.15),normType:c.normType==='consulting'?'consulting':'w2',
   normStopAge:bounded(c.normStopAge,65,35,90),nancyStopAge:bounded(c.nancyStopAge,65,35,90),reserve:bounded(c.reserve,p.liquidReserveFloor??500000,0,1e7),maxWithdrawal:bounded(c.maxWithdrawal,.04,.005,.25),
   extraHealth:bounded(c.extraHealth,0,0,200000),contribution:bounded(c.contribution,0,0,100000),consultingOverhead:bounded(c.consultingOverhead,0,0,1e6),
   normNySource:bounded(c.normNySource,p.locationConfig?.normNySource??1,0,1),practiceNySource:bounded(c.practiceNySource,p.locationConfig?.practiceNySource??0,0,1),
   stress:['base','downturn','earnings25','earnings50','early'].includes(c.stress)?c.stress:'base',vests:c.vests||{}};
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
  const stats=R.map((r,i)=>{const prev=i?R[i-1]:opening;const available=prev?accessible({...prev,yr:r.yr},p,c):0;
   const withdrawal=Math.max(0,r.fiFundingNeed||0)+Number(r.txS||0)+Number(r.sGainTax||0)+Number(r.fiRetTax||0);
   return {yr:r.yr,available,withdrawal,rate:withdrawal>0?(available>0?withdrawal/available:Infinity):0};});
  const fail=result.R.find(r=>r.liq<0||!Number.isFinite(r.netWorth));
  const breach=R.find(r=>r.liq+1<c.reserve*(1+(p.expenseInflation||0))**(r.yr-(p.planStartYear||2026)));
  const excess=stats.find(r=>r.rate>c.maxWithdrawal);
  const status=fail?'Unsustainable':breach||excess?'Borderline':'Sustainable under assumptions';
  const low=R.reduce((a,b)=>accessible(b,p,c)<accessible(a,p,c)?b:a,R[0]);
  return {status,failYear:fail?.yr??null,reserveYear:breach?.yr??null,rateYear:excess?.yr??null,peakRate:Math.max(0,...stats.filter(r=>Number.isFinite(r.rate)).map(r=>r.rate)),stats,
   opening,transition:R[0],min:accessible(low,p,c),minYear:low.yr,final:R.at(-1),drawYears:stats.filter(r=>r.withdrawal>0).length,
   milestones:[60,70,80,90].map(age=>({age,row:result.R.find(r=>r.yr===c.normBirthYear+age)}))};
 }
 function analyze(p,input,M,{scan=true,stresses=true}={}){
  const c=config(p,input),plan=prepare({...p,fiConfig:c},M.run),base=copy(plan);delete base.fiConfig;delete base._fiExpenses;delete base._fiPrepared;
  const original=M.run(p.fiConfig?.enabled?p:base),result=M.run(plan),s=summary(result,plan,c);
  const candidates=[];
  if(scan){const end=Math.min(horizon(c)-1,c.normBirthYear+c.normStopAge-1,horizon(c)-1);
   for(let year=(p.planStartYear||2026)+1;year<=end;year++){const q={...plan,fiConfig:{...c,transitionYear:year}};const t=summary(M.run(q),q,q.fiConfig);candidates.push({year,status:t.status,min:t.min,failYear:t.failYear,peakRate:t.peakRate});}}
  const earliest=candidates.find(x=>x.status==='Sustainable under assumptions')?.year??null;
  const stressResults=stresses?['base','downturn','earnings25','earnings50','early'].map(stress=>{const q={...plan,fiConfig:{...c,stress}};return {stress,...summary(M.run(q),q,q.fiConfig)};}):[];
  const solvent=candidates.find(x=>x.status!=='Unsustainable')?.year??null;
  let requiredNorm=null;
  if(scan&&s.status!=='Sustainable under assumptions'){
   let lo=c.normIncome,hi=2000000;
   const passes=income=>{const q={...plan,fiConfig:{...c,normIncome:income}};return summary(M.run(q),q,q.fiConfig).status==='Sustainable under assumptions';};
   if(passes(hi)){for(let i=0;i<18;i++){const mid=(lo+hi)/2;if(passes(mid))hi=mid;else lo=mid;}requiredNorm=Math.ceil(hi/1000)*1000;}
  }
  return {c,plan,original,result,...s,candidates,earliest,solvent,requiredNorm,stressResults};
 }
 const api={config,horizon,prepare,accessible,afterTaxStripe,summary,analyze};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PlannerFI=api;
})(typeof window!=='undefined'?window:globalThis);
