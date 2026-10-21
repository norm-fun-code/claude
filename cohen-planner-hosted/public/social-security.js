/* SSA retirement method, annual planning convention. Sources/limits are in the FI UI.
 * Future AWI/COLA are assumptions, never presented as an SSA quotation. */
(function(root){
 'use strict';
 const AWI={1990:21027.98,1991:21811.60,1992:22935.42,1993:23132.67,1994:23753.53,1995:24705.66,1996:25913.90,1997:27426,1998:28861.44,1999:30469.84,2000:32154.82,2001:32921.92,2002:33252.09,2003:34064.95,2004:35648.55,2005:36952.94,2006:38651.41,2007:40405.48,2008:41334.97,2009:40711.61,2010:41673.83,2011:42979.61,2012:44321.67,2013:44888.16,2014:46481.52,2015:48098.63,2016:48642.15,2017:50321.89,2018:52145.80,2019:54099.99,2020:55628.60,2021:60575.07,2022:63795.13,2023:66621.80,2024:69846.57,2025:72800.33};
 const CAPS={1990:51300,1991:53400,1992:55500,1993:57600,1994:60600,1995:61200,1996:62700,1997:65400,1998:68400,1999:72600,2000:76200,2001:80400,2002:84900,2003:87000,2004:87900,2005:90000,2006:94200,2007:97500,2008:102000,2009:106800,2010:106800,2011:106800,2012:110100,2013:113700,2014:117000,2015:118500,2016:118500,2017:127200,2018:128400,2019:132900,2020:137700,2021:142800,2022:147000,2023:160200,2024:168600,2025:176100,2026:184500,2027:192300};
 const floorDime=x=>Math.floor((x+1e-8)*10)/10;
 const wageIndex=(year,growth)=>AWI[year]??(year>2025?AWI[2025]*(1+growth)**(year-2025):AWI[1990]/(1+growth)**(1990-year));
 const cap=(year,growth=.025)=>CAPS[year]??(year>2027?192300*(1+growth)**(year-2027):51300/(1+growth)**(1990-year));
 const fra=b=>b>=1960?67:b>=1955?66+(b-1954)*2/12:b>=1943?66:65;
 function claimFactor(age,full=67,monthsWithheld=0){
  const m=Math.max(0,(full-age)*12-monthsWithheld);
  return age<full?1-Math.min(36,m)*.005555555555555556-Math.max(0,m-36)*.004166666666666667:1+Math.min(70-full,age-full)*.08;
 }
 function spouseFactor(age,full=67){const m=Math.max(0,(full-age)*12);return 1-Math.min(36,m)*.006944444444444444-Math.max(0,m-36)*.004166666666666667;}
 function taxable(benefits,otherIncome,single=false){
  const lo=single?25000:32000,hi=single?34000:44000,pi=Math.max(0,otherIncome)+benefits/2;
  if(pi<=lo)return 0;if(pi<=hi)return Math.min(benefits/2,(pi-lo)/2);
  return Math.min(.85*benefits,.85*(pi-hi)+Math.min(benefits/2,(hi-lo)/2));
 }
 function pia(history,birth,year,wageGrowth=.025,cola=.025){
  const eligibility=birth+62,indexYear=birth+60;
  let credits=0;
  const indexed=Object.entries(history).filter(([y])=>Number(y)<year).map(([y,v])=>{
   const covered=Math.min(Math.max(0,v),cap(Number(y),wageGrowth));
   // Credit thresholds are wage indexed; post-1978 annual credits (maximum four).
   const threshold=1890*wageIndex(Number(y)-2,wageGrowth)/wageIndex(2024,wageGrowth);
   credits+=Math.min(4,Math.floor(covered/threshold));
   return Math.round(covered*(Number(y)<indexYear?wageIndex(indexYear,wageGrowth)/wageIndex(Number(y),wageGrowth):1)*100)/100;
  }).sort((a,b)=>b-a).slice(0,35);
  if(credits<40)return {pia:0,aime:0,credits};
  const aime=Math.floor(indexed.reduce((a,b)=>a+b,0)/420);
  const ratio=wageIndex(eligibility-2,wageGrowth)/9779.44;
  const b1=Math.round(180*ratio),b2=Math.round(1085*ratio);
  const raw=.9*Math.min(aime,b1)+.32*Math.max(0,Math.min(aime,b2)-b1)+.15*Math.max(0,aime-b2);
  let adjusted=floorDime(raw);for(let y=eligibility+1;y<=year;y++)adjusted=floorDime(adjusted*(1+cola));
  return {pia:adjusted,aime,credits};
 }
 function create(p,c){
  const sy=p.planStartYear||2026;
  const history={norm:{...(c.normEarningsHistory||{})},nancy:{...(c.nancyEarningsHistory||{})}};
  // Reject future history entries: projected earnings always come from the shared engine.
  for(const h of Object.values(history))for(const y of Object.keys(h))if(+y>=sy)delete h[y];
  const withheld={norm:0,nancy:0},spouseStart={norm:null,nancy:null},last={};
  function step(year,normCovered,nancyCovered,normEarned=normCovered,nancyEarned=nancyCovered){
   const people=['norm','nancy'],data={};
   for(const who of people){
    const birth=c[who+'BirthYear'],age=year-birth,full=fra(birth),claim=c[who+'ClaimAge'];
    const estimate=pia(history[who],birth,year,c.ssWageGrowth,c.ssCola);
    const override=c[who+'SSMonthly'];
    // Override is an FRA monthly estimate expressed in plan-start purchasing power.
    const monthly=override>0?override*(1+(p.expenseInflation??.025))**(birth+full-sy)*(1+c.ssCola)**(year-birth-full):estimate.pia;
    const alive=age<c[who+'DeathAge'];
    const factor=claimFactor(claim,full,age>=full?withheld[who]:0);
    data[who]={...estimate,pia:monthly,age,full,claim,alive,own:age>=claim?monthly*factor:0,amount:0,spousal:0,survivor:0,withheld:0};
   }
   for(const who of people){
    const d=data[who],other=data[who==='norm'?'nancy':'norm'];
    if(!d.alive)continue;
    let amount=d.own;
    if(other.alive&&d.age>=d.claim&&other.age>=other.claim){
     if(spouseStart[who]===null)spouseStart[who]=d.age;
     d.spousal=Math.max(0,.5*other.pia-d.pia)*spouseFactor(spouseStart[who],d.full);
     amount+=d.spousal;
    }
    // Survivor claims at FRA or the chosen claiming age, whichever is later. No automatic
    // early survivor claiming/child-in-care strategy is assumed. Larger benefit replaces own.
    if(!other.alive&&d.age>=Math.max(d.full,d.claim)){
     const deceased=last[who==='norm'?'nancy':'norm']||other;
     const survivor=deceased.pia*Math.max(.825,claimFactor(Math.min(deceased.claim,deceased.age+1),deceased.full,withheld[who==='norm'?'nancy':'norm']));
     const survivorNow=survivor*(1+c.ssCola)**(year-(deceased.year??year));
     d.survivor=Math.max(0,survivorNow-amount);amount+=d.survivor;
    }
    const annual=Math.floor(amount)*12;
    const earned=who==='norm'?normEarned:nancyEarned;
    // Birthdays and claims are January 1 in this annual model: the FRA year has no
    // pre-FRA months. Years entirely before FRA use the ordinary $1-for-$2 test.
    const limit=24480*(1+c.ssWageGrowth)**(year-2026);
    d.withheld=d.age<d.full?Math.min(annual,Math.max(0,earned-limit)/2):0;
    if(annual>0&&d.age<d.full)withheld[who]+=Math.min(12,Math.ceil(d.withheld/(annual/12)));
    d.amount=Math.max(0,annual-d.withheld)*c.ssLevel;d.withheld*=c.ssLevel;d.year=year;
    if(d.alive)last[who]={...d};
   }
   history.norm[year]=Math.min(cap(year,c.ssWageGrowth),Math.max(0,normCovered));
   history.nancy[year]=Math.min(cap(year,c.ssWageGrowth),Math.max(0,nancyCovered));
   return {norm:data.norm.amount,nancy:data.nancy.amount,total:data.norm.amount+data.nancy.amount,withheld:data.norm.withheld+data.nancy.withheld,single:!data.norm.alive||!data.nancy.alive,people:data};
  }
  return {step,history};
 }
 function medicare(p,c,year,magi=0,single=false){
  const f=(1+c.healthInflation)**(year-2026),tf=(1+(p.taxInflation??.025))**(year-2026);
  const thresholds=(single?[109000,137000,171000,205000,500000]:[218000,274000,342000,410000,750000]).map(v=>v*tf);
  let tier=0;while(tier<5&&(tier===4?magi>=thresholds[tier]:magi>thresholds[tier]))tier++;
  const counts=['norm','nancy'].filter(w=>year-c[w+'BirthYear']>=65&&year-c[w+'BirthYear']<c[w+'DeathAge']).length;
  const base=counts*(202.90*12+c.medicareOther)*f;
  const irmaa=counts*([0,81.2,202.9,324.6,446.3,487][tier]+[0,14.5,37.5,60.4,83.3,91][tier])*12*f;
  return {base,irmaa,incremental:Math.max(0,base+irmaa-c.medicareCredit*(1+(p.expenseInflation||0))**(year-(p.planStartYear||2026))),people:counts};
 }
 const api={AWI,CAPS,wageIndex,cap,fra,claimFactor,spouseFactor,taxable,pia,create,medicare};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PlannerSS=api;
})(typeof window!=='undefined'?window:globalThis);
