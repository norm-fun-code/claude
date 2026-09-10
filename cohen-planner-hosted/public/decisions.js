'use strict';
// Decision summaries use the existing projection engine; they never mutate the plan.
(function(root){
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
  const fields={
    homePrice:{label:'Home budget',min:100000,max:6000000,step:50000,format:'money'},
    homePurchaseYear:{label:'Purchase year',min:2026,max:2099,step:1,format:'year'},
    childcareMonthly:{label:'Childcare / child / month',min:0,max:12000,step:100,format:'money'},
    nancyMaxClients:{label:'Nancy’s clients / week',min:0,max:40,step:1,format:'number'},
    investReturn:{label:'Annual portfolio return',min:0,max:0.12,step:0.005,format:'percent'},
  };
  function variant(base,overrides){
    const out={...base};
    for(const [key,value] of Object.entries(overrides)){
      const f=fields[key];
      if(!f||!Number.isFinite(value))throw new Error('Invalid decision input: '+key);
      if(value<f.min||value>f.max)throw new Error('Decision input out of range: '+key);
      out[key]=value;
    }
    // A lighter practice must also cap the initial ramp, otherwise it starts above capacity.
    if('nancyMaxClients' in overrides)out.nancyRampClients=Math.min(out.nancyRampClients,out.nancyMaxClients);
    return out;
  }
  function summarize(p,R,year){
    if(!R.length)throw new Error('No projection years');
    const current=R.find(r=>r.yr===year)||R[0];
    const floor=R.reduce((a,b)=>b.liq<a.liq?b:a);
    const tightest=R.reduce((a,b)=>b.surp<a.surp?b:a);
    const purchase=R.find(r=>r.yr===p.homePurchaseYear)||null;
    const before=R.find(r=>r.yr===p.homePurchaseYear-1);
    // Assets on hand the moment before closing. Stripe belongs here: the funding waterfall
    // sells held shares for the down payment once the portfolio reaches its reserve floor, so
    // measuring readiness against the diversified pool alone understated it by the entire
    // Stripe position — and reported a shortfall for a purchase the model completes.
    const beforeAssets=before?before.liq+before.sEnd
      :p.homePurchaseYear===R[0].yr?(p.startingLiquid||0)+(p.startingStripeEquity||0):null;
    const down=p.homePrice*p.downPctg/100;
    const peak=R.reduce((a,b)=>b.tu+b.cc>a.tu+a.cc?b:a);
    const last=R[R.length-1];
    return{current,floor,tightest,purchase,beforeAssets,down,
      closingBuffer:beforeAssets===null?null:beforeAssets-down,
      peak,last,total:last.nw+last.k401,
      // Years that genuinely reach for savings. Counting r.surp<0 instead would count every
      // year cash pay alone falls short — which, with a stock-heavy package, is nearly all
      // of them even when that year's vest closes the gap and nothing is liquidated.
      deficitYears:R.filter(r=>r.sold>0||r.sHold>0).length};
  }
  function milestones(p,R){
    const events=[];const add=(yr,label,kind)=>{if(R.some(r=>r.yr===yr))events.push({yr,label,kind});};
    for(let i=1;i<=p.numKids;i++){
      const birth=p['kid'+i+'Birth'];
      add(birth,'Baby '+i+' arrives','family');
      add(birth+(i===1?p.kid1YeshivaStartAge:p.yeshivaStartAge),'Kid '+i+' starts school','school');
    }
    add(p.homePurchaseYear,'Move into your home','home');
    add(p.nancyRampYear+p.nancyRampYears,'Nancy’s practice at capacity','work');
    const peak=R.reduce((a,b)=>b.tu+b.cc>a.tu+a.cc?b:a);
    if(peak.tu+peak.cc>0)add(peak.yr,'Peak education + care','school');
    return events.sort((a,b)=>a.yr-b.yr);
  }
  function preset(p,key){
    const presets={
      smaller:{homePrice:clamp(p.homePrice-200000,100000,6000000)},
      later:{homePurchaseYear:clamp(p.homePurchaseYear+2,p.planStartYear,2099)},
      care:{childcareMonthly:clamp((p.childcareMonthly??2800)+1000,0,12000)},
      time:{nancyMaxClients:clamp(p.nancyMaxClients-3,0,40)},
      returns:{investReturn:clamp(p.investReturn-.02,0,.12)},
    };
    if(!presets[key])throw new Error('Unknown decision');
    return presets[key];
  }
  function usableSnapshot(s){
    if(!s||s.partial||!['netWorth','liquid','retirement','assets','liabilities'].every(k=>Number.isFinite(s[k])))return false;
    if(!Number.isFinite(Date.parse(s.syncedAt)))return false;
    // Legacy empty responses were stored as all-zero balances. Require evidence for zero.
    return s.accountCount>0||s.assets!==0||s.liabilities!==0;
  }
  const api={fields,variant,summarize,milestones,preset,usableSnapshot};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerDecisions=api;
})(typeof window!=='undefined'?window:this);
