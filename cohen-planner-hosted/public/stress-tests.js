'use strict';
(function(root){
  const PRESETS=[{id:'income',name:'Income interruption'},{id:'freeze',name:'Stripe sales delayed'},{id:'inflation',name:'Higher spending inflation'},{id:'combined',name:'Combined stress'}];
  function plan(p,id,start){
    if(!PRESETS.some(x=>x.id===id)||!Number.isInteger(start)||start<(p.planStartYear||2026)||start>(p.planEndYear||2058))throw new Error('Choose a valid annual stress year.');
    const out=JSON.parse(JSON.stringify(p));out._annualStress={};
    const rate=Number(p.expenseInflation)||0;
    for(let yr=start;yr<=(p.planEndYear||2058);yr++){
      const shock={};
      if((id==='income'||id==='combined')&&yr===start)shock.normIncomeScale=0;
      if((id==='freeze'||id==='combined')&&yr<start+2)shock.stripeSalesBlocked=true;
      if(id==='inflation'||id==='combined')shock.expenseMultiplier=((1+rate+.02)/(1+rate))**Math.min(3,yr-start+1);
      out._annualStress[yr]=shock;
    }
    return out;
  }
  function summarize(rows,p,start){
    const future=rows.filter(r=>r.yr>=start),floor=Number(p.liquidReserveFloor??p.stripeLiquidFloor??500000);
    const low=future.reduce((a,b)=>a.liq<b.liq?a:b);
    const breach=future.find(r=>r.liq<floor-1),unfunded=future.find(r=>r.liq<0);
    const active=future.filter(r=>r.yr<start+3);
    return {low:low.liq,lowYear:low.yr,breachYear:breach?.yr??null,unfundedYear:unfunded?.yr??null,
      stripeSales:active.reduce((s,r)=>s+r.sSold+r.sHold,0),finalNetWorth:rows.at(-1).netWorth};
  }
  function cashMetrics(row,accessible){
    const monthlySpending=row.totEFull/12;
    return {cashMargin:(row.incFull-row.totEFull)/12,runwayMonths:monthlySpending>0?Math.max(0,accessible)/monthlySpending:null,
      stripeGrossSales:row.sSold+row.sHold,periodMonths:12*(row.stubFrac??1)};
  }
  const api={PRESETS,plan,summarize,cashMetrics};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PlannerStress=api;
})(typeof window!=='undefined'?window:this);
