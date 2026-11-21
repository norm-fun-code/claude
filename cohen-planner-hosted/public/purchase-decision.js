'use strict';
(function(root){
  const L=typeof module!=='undefined'&&module.exports?require('./liquidity.js'):root.PlannerLiquidity;
  const clamp=x=>Math.max(0,Math.min(1,x));
  // A dated sources-and-uses estimate. Start at the previous close, never the purchase-year
  // ending balance (which has already spent the down payment). Do not add ordinary income.
  function closing(p,rows,{quarter=L.purchaseQuarter(p),need,pause=0,cap,manualElection=false,stress=false}={}){
    const y=p.homePurchaseYear,i=rows.findIndex(r=>r.yr===y),r=rows[i];
    if(!r)return null;
    const prev=rows[i-1],floor=p.liquidReserveFloor??500000;
    const tax=clamp(r.capGainsRate??p.capGainsTaxRate??0);
    const raw=prev?.liq??p.startingLiquid??0;
    const portfolio=Math.max(0,raw-floor-(pause/12)*r.totEFull)*(1-tax*(1-clamp(p.costBasisPct??1)));
    const held=Math.max(0,prev?.sEnd??p.startingStripeEquity??0);
    const basis=prev?.sBasis??held*(p.stripeStartingBasisPct??1);
    const cfg=L.cfg(p),mark=stress ? 0.7 : 1;
    const openingMonth=!prev&&String(p.observedOn||'').startsWith(String(y))?Number(String(p.observedOn).slice(5,7)):0;
    const firstQ=Math.max(1,Math.ceil(openingMonth/3)),elapsed=quarter<firstQ;
    const tracked=Array.isArray(r.qcaNetQuarters)&&!r.sGrantDetails?.manual;
    const v=r.sVestByQuarter||Array.from({length:4},(_,j)=>j+1<firstQ?0:(r.sAvailable??r.sNew??0)/(5-firstQ));
    const stock=v.map(x=>Math.max(0,x));
    let elective=0,annual=cfg.electiveCashAnnualCap;
    for(let j=0;j<quarter;j++){
      if(j+1<firstQ)continue;
      if(tracked){elective+=r.qcaNetQuarters[j]||0;continue;}
      if(!manualElection||r.fiActive)continue;
      const net=1-clamp(r.sVestRate??0);
      const cash=Math.min(stock[j],Math.max(0,Math.min(annual,cfg.electiveCashPerQuarter))*net);
      stock[j]-=cash;elective+=cash;if(net>0)annual-=cash/net;
    }
    let windows=[...cfg.tenderQuarters].filter(q=>q>=firstQ&&!(openingMonth>=2&&q===1)).sort((a,b)=>a-b);
    if(stress&&windows.length)windows[0]+=2;
    const cp={...p,stripeSimplified:true,stripeTenderQuarters:[...new Set(windows.filter(q=>q<=4))],stripeTenderCapPerEvent:cap??cfg.tenderCapPerEvent,
      costBasisPct:held*mark>0?clamp(basis/(held*mark)):1,capGainsTaxRate:tax};
    const sale=L.fundingCheck({year:y,quarter,need,heldValue:held*mark,vestByQuarter:stock.map(v=>v*mark),otherCash:0},cp);
    const shares=r.stripeSalesBlocked||elapsed?0:sale.fromStripe;
    const available=portfolio+elective+shares,shortfall=Math.max(0,need-available);
    const used=Math.min(need,portfolio),usedElection=Math.min(need-used,elective),usedSales=Math.min(need-used-usedElection,shares);
    return {...sale,need,quarter,portfolio,otherCash:portfolio,elective,shares,available,shortfall,fundable:!elapsed&&shortfall<.01,elapsed,tracked,
      used,usedElection,usedSales,fromStripe:elective+shares,free:L.freelyLiquid(y,p),remedy:shortfall>0?'Try a later closing quarter or a smaller down payment.':null};
  }
  function assess(p,rows,years,funds){
    const owned=rows.filter(r=>r.yr>=p.homePurchaseYear);if(!owned.length||!funds)return null;
    const low=owned.reduce((a,b)=>a.liq<=b.liq?a:b);
    const tight=owned.reduce((a,b)=>a.flowFull<=b.flowFull?a:b);
    const peak=years.reduce((a,b)=>!a||b.share>a.share?b:a,null);
    return {owned,low,tight,peak,funds,margin:low.liq-(p.liquidReserveFloor??500000)};
  }
  // Anchor to the original purchase's tightest operating year, even if the preview moves it.
  function peakImpact(baseRows,previewRows,purchaseYear){
    const base=baseRows.filter(r=>r.yr>=purchaseYear).reduce((a,b)=>!a||b.flowFull<a.flowFull?b:a,null);
    const preview=base&&previewRows.find(r=>r.yr===base.yr);
    if(!preview)return null;
    return {year:base.yr,base,preview,flowDelta:preview.flowFull-base.flowFull,wealthDelta:preview.netWorth-base.netWorth};
  }
  const api={closing,assess,peakImpact};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PurchaseDecision=api;
})(typeof window!=='undefined'?window:this);
