'use strict';
// Calendar-year grant ledger shared by browser, server and projections. No stored derived totals.
(function(root){
  const finite=(v,d=0)=>v!==null&&v!==''&&Number.isFinite(Number(v))?Number(v):d;
  const positive=(v,d)=>Math.max(.000001,finite(v,d));
  const active=p=>p.stripeGrants?.enabled===true;
  const iso=(y,m,d)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  function dates(p){return (p.stripeVestDates||p.stripeVestMonths?.map(m=>[m,1])||[[3,15],[6,15],[9,15],[12,15]]).slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);}
  function setup(p){return {version:1,enabled:false,priceYear:p.planStartYear||2026,referenceTender:null,reference409a:null,referenceValuation:null,valuationCeiling:null,dilutionRate:0,grantGrowth:0,defaultARG:77800,defaultPEG:50000,defaultMultiplier:1,defaultElection:'arg',cashAlreadyIncluded:0,years:{},prices:{},actualGrants:[]};}
  function award(p,y){
    const c=p.stripeGrants||setup(p), row=c.years?.[y]||{};
    // Carry the most recent explicit dollar inputs forward (promotions persist).
    const prior=Object.keys(c.years||{}).map(Number).filter(v=>v<y).sort((a,b)=>b-a)[0];
    const prev=prior==null?{}:c.years[prior];
    const factor=(1+finite(c.grantGrowth))**Math.max(0,y-(prior??c.priceYear));
    return {arg:Math.max(0,finite(row.arg,finite(prev.arg,finite(c.defaultARG,77800))*factor)),peg:Math.max(0,finite(row.peg,finite(prev.peg,finite(c.defaultPEG,50000))*factor)),multiplier:Math.max(0,finite(row.multiplier,finite(prev.multiplier,finite(c.defaultMultiplier,1)))),election:row.election||prev.election||c.defaultElection||'arg',qca:row.qca||prev.qca||['cash','cash','cash','cash'],cashAlreadyIncluded:Math.max(0,finite(row.cashAlreadyIncluded,finite(prev.cashAlreadyIncluded,finite(c.cashAlreadyIncluded))))};
  }
  function returnFor(p,y){const i=y-(p.planStartYear||2026);return Math.max(-.99,finite(i>=0&&i<10?p['stripeRetY'+i]:null,finite(p.stripeLongTermReturn,.08)));}
  function pricePath(p,from,to){
    const c=p.stripeGrants, base=finite(c.priceYear,p.planStartYear||2026), out={};
    const ref=positive(c.referenceTender,1), val=finite(c.referenceValuation), ratio=positive(c.reference409a,ref)/ref;
    let tender=ref, valuation=val;
    // Pre-anchor prices are estimates at the reference price unless explicitly entered.
    for(let y=Math.min(from,base);y<=Math.max(to,base);y++){
      const o=c.prices?.[y]||{};
      if(y<base){tender=ref;valuation=val;}
      if(y>base){
        const old=valuation, growth=1+returnFor(p,y-1);
        valuation=old>0?old*growth:0;
        if(c.valuationCeiling>0&&valuation>old)valuation=Math.max(old,Math.min(valuation,c.valuationCeiling));
        tender*= (old>0?valuation/old:growth)/(1+Math.max(0,finite(c.dilutionRate)));
      }
      if(o.valuation>0){if(valuation>0)tender*=o.valuation/valuation;valuation=Number(o.valuation);}
      if(o.tender>0)tender=Number(o.tender);
      // A historical override must not move the anchor itself.
      if(y===base){tender=positive(o.tender,ref);valuation=finite(o.valuation,val);}
      const qa=Array.from({length:4},(_,q)=>positive(o.q409a?.[q],tender*ratio));
      const fmv=Array.from({length:4},(_,q)=>positive(o.vestFMV?.[q],qa[q]));
      out[y]={year:y,tender,valuation,grant:positive(o.grant,tender),q409a:qa,vestFMV:fmv,historicalEstimate:y<base&&!(o.grant>0)};
    }
    return out;
  }
  function validate(p){
    const c=p.stripeGrants, errors=[];
    if(!c)return ['Set up the grant model first.'];
    for(const k of ['referenceTender','reference409a'])if(!(Number(c[k])>0&&Number.isFinite(Number(c[k]))))errors.push(`Enter a positive ${k==='referenceTender'?'reference tender price':'reference 409A price'}.`);
    if(c.valuationCeiling>0&&!(c.referenceValuation>0))errors.push('A valuation ceiling requires a reference valuation.');
    for(const k of ['priceYear'])if(!Number.isInteger(c[k])||c[k]<2000||c[k]>2100)errors.push('Reference year must be between 2000 and 2100.');
    for(const k of ['referenceValuation','valuationCeiling','cashAlreadyIncluded','defaultARG','defaultPEG','defaultMultiplier'])if(c[k]!=null&&(!Number.isFinite(Number(c[k]))||c[k]<0))errors.push(`${k} must be a non-negative number.`);
    for(const k of ['dilutionRate','grantGrowth'])if(c[k]!=null&&(!Number.isFinite(Number(c[k]))||c[k]<0||c[k]>1))errors.push(`${k} must be between 0 and 1.`);
    for(const row of Object.values(c.years||{})){
      for(const k of ['arg','peg','multiplier','cashAlreadyIncluded'])if(row[k]!=null&&(!Number.isFinite(Number(row[k]))||row[k]<0))errors.push(`Award ${k} must be a non-negative number.`);
      if(row.election&&!['arg','qca'].includes(row.election))errors.push('Choose ARG or QCA for the annual award.');
      if(row.qca&&(row.qca.length!==4||row.qca.some(v=>!['stock','cash'].includes(v))))errors.push('QCA needs four cash/stock choices.');
    }
    for(const row of Object.values(c.prices||{}))for(const v of [row.grant,row.tender,row.valuation,...(row.q409a||[]),...(row.vestFMV||[])])if(v!=null&&(!(v>0)||!Number.isFinite(Number(v))))errors.push('Price overrides must be positive or blank.');
    const ds=dates(p);if(ds.length!==4||ds.some(([m,d])=>m<1||m>12||d<1||d>28))errors.push('Use four valid quarterly vest dates (days 1–28).');
    const keys=new Set();
    for(const g of c.actualGrants||[]){
      const key=`${g.type}:${g.year}`;
      if(keys.has(key))errors.push(`Only one actual ${key} schedule is allowed; combine tranches in its vest rows.`);keys.add(key);
      if(!['ARG','PEG'].includes(g.type)||!Number.isInteger(Number(g.year)))errors.push('Actual grants need a type and grant year.');
      if(!Array.isArray(g.vests)||!g.vests.length)errors.push(`${key} needs at least one vest row.`);
      if(g.type==='ARG'&&award(p,Number(g.year)).election==='qca')errors.push(`ARG ${g.year} has actual shares. Keep its ARG election or remove that schedule before choosing QCA.`);
      if(g.scheduleMode==='remaining'&&!/^\d{4}-\d{2}-\d{2}$/.test(g.asOf||''))errors.push('Remaining schedules need an as-of date.');
      const unique=new Set();for(const v of g.vests||[]){if(unique.has(v.date))errors.push(`${key} repeats a vest date.`);unique.add(v.date);}
      for(const v of [...(g.vests||[]),...(g.history||[])]){const d=new Date(v.date+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==v.date||(v.shares!=null&&(!Number.isFinite(Number(v.shares))||v.shares<0)))errors.push(`${key} has an invalid vest date or share amount.`);}
    }
    return errors;
  }
  function compile(p){
    const errors=validate(p);if(errors.length)throw new Error(errors.join(' '));
    const c=p.stripeGrants, sy=p.planStartYear||2026, ey=p.planEndYear||2058;
    const from=Math.min(sy-2,...(c.actualGrants||[]).map(g=>Number(g.year)));
    const prices=pricePath(p,from,ey+2), years={}, grants=[], warnings=[];
    for(let y=sy;y<=ey;y++)years[y]={year:y,stock:0,cash:0,market:0,shares:0,events:[],arg:0,peg:0,qcaStock:0};
    function add(g,date,shares,cash=0,status=g.status){
      const y=Number(date.slice(0,4));if(!years[y])return;
      const q=Math.floor((Number(date.slice(5,7))-1)/3), pr=prices[y];
      const stock=shares*pr.vestFMV[q], market=shares*pr.tender;
      const event={grantId:g.id,type:g.type,grantYear:g.year,status,date,quarter:q+1,shares,cash,stock,market,vestPrice:pr.vestFMV[q],tenderPrice:pr.tender,grantPrice:g.price};
      const yr=years[y];yr.events.push(event);yr.stock+=stock;yr.cash+=cash;yr.market+=market;yr.shares+=shares;
      yr[g.type==='PEG'?'peg':g.type==='ARG'?'arg':'qcaStock']+=stock;
    }
    const actual=new Map((c.actualGrants||[]).map(g=>[`${g.type}:${g.year}`,g]));
    for(let y=from;y<=ey;y++){
      const a=award(p,y), price=prices[y].grant;
      for(const type of ['ARG','PEG']){
        const known=actual.get(`${type}:${y}`);
        if(type==='ARG'&&a.election==='qca'&&!known)continue;
        const dollars=type==='ARG'?a.arg:a.peg*a.multiplier, n=type==='ARG'?4:8;
        const g={id:`${type}:${y}`,type,year:y,dollars,price:known?.grantPrice>0?Number(known.grantPrice):price,status:'Estimated',shares:dollars/price,vests:[]};
        const starts=c.years?.[y]?.[type==='ARG'?'argFirstVest':'pegFirstVest'];
        const candidates=[];
        for(let vy=y;vy<=y+3;vy++)for(const [m,d]of dates(p)){const date=iso(vy,m,d);if(starts?date>=starts:m>5||vy>y)candidates.push(date);}
        const estimated=candidates.slice(0,n).map(date=>({date,shares:dollars/price/n,status:'Estimated'}));
        if(known){
          const past=known.scheduleMode==='remaining'?estimated.filter(v=>v.date<=known.asOf).map(v=>{const h=known.history?.find(h=>h.date===v.date&&h.shares!=null);return h?{...v,shares:Number(h.shares),status:'Actual'}:v;}):[];
          const future=known.scheduleMode==='remaining'?estimated.filter(v=>v.date>known.asOf):estimated;
          g.vests=[...past,...known.vests.map((v,i)=>({date:v.date,shares:v.shares==null?(future[i]?.shares??dollars/price/n):Number(v.shares),status:v.shares==null?'Estimated':'Actual'}))];
          g.status=g.vests.every(v=>v.status==='Actual')?'Actual':'Mixed';
          if(g.status==='Mixed')warnings.push(`${type} ${y}: missing share amounts use the May-price estimate; actual rows stay fixed.`);
        }else g.vests=estimated;
        g.shares=g.vests.reduce((s,v)=>s+v.shares,0);
        if(y<sy&&dollars>0&&prices[y].historicalEstimate&&g.vests.some(v=>v.status==='Estimated'))warnings.push(`${type} ${y}: historical May price is estimated; enter its price or actual shares.`);
        grants.push(g);for(const v of g.vests)add(g,v.date,v.shares,0,v.status);
      }
      // QCA covers the same June-to-March award year as ARG. An actual ARG supersedes QCA.
      if(a.election==='qca'&&!actual.has(`ARG:${y}`)){
        const g={id:`QCA:${y}`,type:'QCA',year:y,status:'Estimated',dollars:a.arg,price:null,shares:0,vests:[]};
        const ds=[];for(let vy=y;vy<=y+1;vy++)for(const [m,d]of dates(p))if(vy>y||m>5)ds.push(iso(vy,m,d));
        ds.slice(0,4).forEach((date,i)=>{const yy=Number(date.slice(0,4)),q=Math.floor((Number(date.slice(5,7))-1)/3),cash=a.qca[i]!=='stock'?a.arg/4:0,shares=cash?0:a.arg/4/prices[yy].q409a[q];g.shares+=shares;g.vests.push({date,shares,cash});add(g,date,shares,cash);});grants.push(g);
      }
    }
    for(const yr of Object.values(years))yr.events.sort((a,b)=>a.date.localeCompare(b.date)||a.grantId.localeCompare(b.grantId));
    if(!c.actualGrants?.length)warnings.push('All grants are estimated. Enter actual schedules to anchor existing awards.');
    return {years,grants,prices,warnings:[...new Set(warnings)]};
  }
  const api={active,setup,award,returnFor,pricePath,validate,compile,dates};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.StripeGrants=api;
})(typeof window!=='undefined'?window:this);
