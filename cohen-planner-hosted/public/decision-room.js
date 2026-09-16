'use strict';
let decisionYear=null;
let decisionOverrides={};
let decisionName='';
let decisionBaseKey='';
let decisionSaving=false;
let decisionContext=null;
const decisionMoney=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n);
const decisionEsc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function decisionValue(key,value){
  const f=PlannerDecisions.fields[key];
  if(f.format==='months')return value?value+' mo old':'birth';
  return f.format==='money'?decisionMoney(value):f.format==='percent'?(value*100).toFixed(1)+'%'
    :f.format==='rate'?value.toFixed(3).replace(/0+$/,'').replace(/\.$/,'')+'%'
    :f.format==='pct'?value+'%':String(value);
}
function decisionDelta(n){return (n>0?'+':'')+fmt(n);}
function decisionDollars(n,year){return inflationView?n/(1+P.expenseInflation)**(year-P.planStartYear):n;}
function decisionSyncBase(){
  const key=JSON.stringify(P);
  if(decisionBaseKey&&decisionBaseKey!==key){decisionOverrides={};decisionName='';}
  decisionBaseKey=key;
}
function renderDecisionRoom(R){
  decisionSyncBase();
  if(decisionYear===null)decisionYear=Math.max(R[0].yr,Math.min(R[R.length-1].yr,new Date().getFullYear()));
  decisionYear=Math.max(R[0].yr,Math.min(R[R.length-1].yr,decisionYear));
  const summary=PlannerDecisions.summarize(P,R,decisionYear);
  const events=PlannerDecisions.milestones(P,R);
  const todayYear=Math.max(R[0].yr,Math.min(R[R.length-1].yr,new Date().getFullYear()));
  const today=R.find(r=>r.yr===todayYear);
  const title=summary.floor.liq<0?'Your plan has a funding gap.':summary.deficitYears>0?'Some years draw on savings.':'Your next chapter, in focus.';
  const detail=summary.floor.liq<0?`Projected liquid assets turn negative. Explore the timing and trade-offs below.`:summary.deficitYears>0?`${summary.deficitYears} ${summary.deficitYears===1?'year draws':'years draw'} on investments to cover spending. Start with the tightest year.`:`Your current assumptions cover annual spending in every modeled year. Explore how your choices change that path.`;
  const upcoming=events.filter(e=>e.yr>=todayYear).slice(0,4);
  const synced=PlannerDecisions.usableSnapshot(monarchSnapshot);
  const age=synced?Math.max(0,Math.floor((Date.now()-Date.parse(monarchSnapshot.syncedAt))/86400000)):null;
  const source=synced?`Monarch · ${new Date(monarchSnapshot.syncedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}${age>7?' · refresh recommended':''}`:(monarchSnapshot?.partial?'Plan assumptions · account totals incomplete (see Portfolio)':(monarchSnapshot?.partial?'Plan assumptions · account totals incomplete (see Portfolio)':'Plan assumptions · live balances unavailable'));
  document.getElementById('summaries').innerHTML='';
  document.getElementById('chartArea').innerHTML=`<div class="decision-room">
    <section class="dr-intro">
      <div><h2>${title}</h2><p>${detail}</p>
      </div>
    </section>
    <section class="dr-card" id="decisionLab"><div class="dr-section-head"><div><h3>Explore a what-if</h3><p>Try a starting point, then combine changes. Your current plan stays intact.</p></div><button class="dr-secondary" onclick="decisionReset()">Reset preview</button></div>
      <div class="dr-presets">${[['smaller','A $200K smaller home'],['later','Buy 2 years later'],['rate','Mortgage rate +1%'],['down','10% more down'],['care','An extra $1K in childcare'],['time','3 fewer clients / week'],['returns','Returns 2 points lower']].map(([key,label])=>`<button onclick="decisionPreset('${key}')">${label}</button>`).join('')}</div>
      <div class="dr-lab-layout"><div class="dr-sliders">${Object.entries(PlannerDecisions.fields).map(([key,f])=>{
        const value=decisionOverrides[key]??P[key];
        const min=key==='homePurchaseYear'?Math.min(P.planStartYear,value):Math.min(f.min,value);
        const max=Math.max(f.max,value);
        return `<div class="dr-control"><label for="dr-${key}">${f.label}<output id="dr-value-${key}">${decisionValue(key,value)}</output></label><input id="dr-${key}" type="range" min="${min}" max="${max}" step="${f.step}" value="${value}" oninput="decisionChange('${key}',Number(this.value))"><span>Current plan: ${decisionValue(key,P[key])}</span></div>`;
      }).join('')}</div><div class="dr-impact"><div id="decisionImpact" aria-live="polite"></div><div class="dr-save"><label for="decisionName">Scenario name</label><input id="decisionName" type="text" maxlength="80" placeholder="e.g. More family time" value="${decisionEsc(decisionName)}" oninput="decisionName=this.value"><div><button id="decisionSave" class="dr-primary" onclick="decisionSaveScenario()">Save as new scenario</button><button class="dr-secondary" onclick="decisionAsk('variant')">Ask advisor about this</button></div><p id="decisionSaveStatus" role="status">Saving adds a separate scenario for comparison.</p></div></div></div>
    </section>
    <details class="polish-fold refine-fold dr-context" id="decisionContextFold"><summary>Current plan context & timeline</summary>
    <div class="dr-metrics">
      <article><span>Before closing · ${P.homePurchaseYear}</span><strong>${summary.closingBuffer===null?'Outside horizon':fmt(summary.closingBuffer)}</strong><p>${summary.closingBuffer===null?'Choose a purchase year within the plan.':`Investable assets (portfolio + Stripe) the year before, less the ${fmt(summary.down)} down payment. Before closing costs and taxes on the sales that fund it.`}</p></article>
      <article><span>Lowest projected liquid assets</span><strong class="${summary.floor.liq<0?'dr-negative':''}">${fmt(summary.floor.liq)}</strong><p>${summary.floor.yr} year-end · includes invested assets; not a cash reserve.</p></article>
      <article><span>Tightest cash-flow year · ${summary.tightest.yr}</span><strong class="${summary.tightest.flow<0?'dr-negative':''}">${decisionMoney(summary.tightest.flowMonthly)}<small>/mo</small></strong><p>Net flow per modeled month — all income, all spending. Home down payment is separate.</p><button class="dr-text-button" onclick="decisionSelectYear(${summary.tightest.yr})">Explore this year →</button></article>
    </div>
    <section class="dr-card dr-timeline"><div class="dr-section-head"><div><h3>Life & money timeline</h3></div><span class="dr-pill">${inflationView?P.planStartYear+' purchasing power':'Future dollars'} · projections</span></div>
      <div class="dr-timeline-layout"><div><div id="decisionChart"></div><div class="dr-scrubber"><label for="decisionYear">Explore year <output id="decisionYearLabel">${decisionYear}</output></label><input id="decisionYear" type="range" min="${R[0].yr}" max="${R[R.length-1].yr}" step="1" value="${decisionYear}" oninput="decisionSelectYear(Number(this.value))"><div><span>${R[0].yr}</span><span>${R[R.length-1].yr}</span></div></div></div><div id="decisionYearDetail" class="dr-year-detail" aria-live="polite"></div></div>
      <div class="dr-milestones">${upcoming.map(e=>`<button onclick="decisionSelectYear(${e.yr})"><span>${e.yr}</span>${decisionEsc(e.label)}<b aria-hidden="true">↗</b></button>`).join('')||'<p>No upcoming milestones within this horizon.</p>'}</div>
    </section>
    </details>
    <details class="dr-method"><summary>What these numbers include</summary><p>All previews use your existing annual projection and tax model. Total net worth includes liquid assets, Stripe equity, home equity and retirement, less modeled debt. Retirement is also shown separately so you can see its contribution. Monthly margin is net flow: all after-tax pay less all modeled spending. A year can need part of the Stripe vest sold to cover spending and still have positive net flow; that is not a deficit, and the amount to sell is shown beside it. Liquid assets include investments and are not the same as cash. Net flow excludes the home down payment. The closing buffer uses the previous year-end investable balance — the diversified portfolio plus Stripe equity, since the funding waterfall sells held Stripe for the down payment once the portfolio reaches its reserve floor — less the down payment. It excludes closing costs and the capital-gains tax on those sales. The existing model continues employment income and retirement contributions through the end of the plan; this is not a retirement drawdown simulation. Returns are assumptions, not guaranteed outcomes. Changing home price holds maintenance and other expenses fixed unless you edit them in Settings. Changing childcare applies the monthly rate to each eligible child.</p></details>
  </div>`;
  decisionContext={R,events};
  decisionUpdatePreview();
}
// `reveal` opens the context fold, which is right when the year was chosen from a milestone
// or the tightest-year button DOWN there — you want to land where you clicked. It is wrong
// when the year was chosen from the picker beside the comparison, which would then throw a
// fold open underneath the thing you were reading.
function decisionSelectYear(year,reveal){
  if(reveal!==false){const fold=document.getElementById('decisionContextFold');if(fold)fold.open=true;}
  if(!decisionContext)return;
  decisionYear=Math.max(P.planStartYear,Math.min(P.planEndYear,year));
  const slider=document.getElementById('decisionYear');if(slider)slider.value=decisionYear;
  const label=document.getElementById('decisionYearLabel');if(label)label.textContent=decisionYear;
  const picker=document.getElementById('decisionYearPick');if(picker)picker.value=decisionYear;
  decisionUpdatePreview();
}
// Step one year without leaving the keyboard or hunting the right option in a list of 33.
function decisionStepYear(by){
  const R=decisionContext&&decisionContext.R;if(!R)return;
  decisionSelectYear(Math.max(R[0].yr,Math.min(R[R.length-1].yr,decisionYear+by)),false);
}
function decisionPreset(key){
  decisionOverrides=PlannerDecisions.preset(P,key);
  decisionName={smaller:'Smaller home',later:'Buy two years later',care:'Higher childcare',time:'More family time',returns:'Lower returns'}[key];
  renderDecisionRoom(run(P).R);
}
function decisionReset(){decisionOverrides={};decisionName='';renderDecisionRoom(run(P).R);}
function decisionChange(key,value){
  if(value===P[key])delete decisionOverrides[key];else decisionOverrides[key]=value;
  document.getElementById('dr-value-'+key).textContent=decisionValue(key,value);
  decisionUpdatePreview();
}
function decisionUpdatePreview(){
  const base=decisionContext.R;
  const params=PlannerDecisions.variant(P,decisionOverrides);
  const changed=Object.keys(params).filter(k=>params[k]!==P[k]);
  const preview=changed.length?run(params).R:base;
  const a=PlannerDecisions.summarize(P,base,decisionYear),b=PlannerDecisions.summarize(params,preview,decisionYear);
  decisionContext.preview=preview;decisionContext.params=params;
  const delta=decisionDollars(b.netWorth-a.netWorth,a.last.yr);
  // ── The comparison ──
  // Split in two, because the two halves answer different questions and reading them as one
  // list made only the plan-end rows feel like the answer. The top half is ONE YEAR, chosen
  // here rather than buried in a fold below: a what-if is usually asked about a particular
  // year — the year the baby arrives, the year you buy — and "net worth in 2058" cannot
  // answer that.
  const yr=decisionYear;
  const at=(v,y)=>decisionDollars(v,y==null?yr:y);
  // A change column is the point of the panel, so it is computed rather than left to the
  // reader. Only where BOTH sides are real numbers: a delta between "None" and "Outside
  // horizon" is not a number, and printing one would be an invention.
  //
  // The colour follows whether the change is GOOD, not whether the number went up. More
  // spending, more vest sold to cover it and more years drawing on savings are all rises, and
  // all three are worse — painting them green would have the panel telling you the opposite
  // of what it means. `worseUp` marks those.
  const chg=(x,z,f,worseUp)=>{
    if(!Number.isFinite(x)||!Number.isFinite(z))return '<td class="dr-chg">—</td>';
    const d=z-x;
    if(Math.round(d)===0)return '<td class="dr-chg">no change</td>';
    const good=worseUp?d<0:d>0;
    return `<td class="dr-chg ${good?'dr-up':'dr-down'}">${(d>0?'+':'−')+(f||fmt)(Math.abs(d))}</td>`;
  };
  const rows=[
    ['head',`In ${yr}`],
    ['Net flow / mo',decisionMoney(at(a.current.flow)/12),decisionMoney(at(b.current.flow)/12),
      chg(at(a.current.flow)/12,at(b.current.flow)/12,decisionMoney)],
    ['Total spending',fmt(at(a.current.totE)),fmt(at(b.current.totE)),chg(at(a.current.totE),at(b.current.totE),null,true)],
    ['Vest sold to cover',a.current.gap>0?fmt(at(a.current.gap)):'None',b.current.gap>0?fmt(at(b.current.gap)):'None',
      chg(at(a.current.gap),at(b.current.gap),null,true)],
    ['Liquid assets',fmt(at(a.current.liq)),fmt(at(b.current.liq)),chg(at(a.current.liq),at(b.current.liq))],
    ['Net worth',fmt(at(a.current.netWorth)),fmt(at(b.current.netWorth)),chg(at(a.current.netWorth),at(b.current.netWorth))],
    ['head','Across the whole plan'],
    [`Net worth ${a.last.yr}`,fmt(at(a.netWorth,a.last.yr)),fmt(at(b.netWorth,b.last.yr)),
      chg(at(a.netWorth,a.last.yr),at(b.netWorth,b.last.yr))],
    [`401k ${a.last.yr}`,fmt(at(a.retirement,a.last.yr)),fmt(at(b.retirement,b.last.yr)),
      chg(at(a.retirement,a.last.yr),at(b.retirement,b.last.yr))],
    ['Lowest liquid assets',`${fmt(at(a.floor.liq,a.floor.yr))}<small>${a.floor.yr}</small>`,
      `${fmt(at(b.floor.liq,b.floor.yr))}<small>${b.floor.yr}</small>`,
      chg(at(a.floor.liq,a.floor.yr),at(b.floor.liq,b.floor.yr))],
    ['Years drawing on savings',a.deficitYears,b.deficitYears,
      chg(a.deficitYears,b.deficitYears,n=>n+(n===1?' yr':' yrs'),true)],
    ['Before-closing buffer (incl. Stripe)',
      a.closingBuffer===null?'Outside horizon':`${fmt(at(a.closingBuffer,P.homePurchaseYear))}<small>${P.homePurchaseYear}</small>`,
      b.closingBuffer===null?'Outside horizon':`${fmt(at(b.closingBuffer,params.homePurchaseYear))}<small>${params.homePurchaseYear}</small>`,
      chg(a.closingBuffer,b.closingBuffer)],
  ];
  const years=base.map(r=>r.yr);
  document.getElementById('decisionImpact').innerHTML=`<div class="dr-kicker">${changed.length?'PREVIEW VS CURRENT PLAN':'YOUR CURRENT PLAN'}</div><div class="dr-impact-number ${delta<0?'dr-negative':''}">${changed.length?decisionDelta(delta):fmt(decisionDollars(a.netWorth,a.last.yr))}</div><p>${changed.length?'Change in net worth':'Projected net worth'} in ${a.last.yr} · ${inflationView?P.planStartYear+' dollars':'future dollars'}</p>
    <div class="dr-yearpick">
      <label for="decisionYearPick">Compare year</label>
      <button type="button" onclick="decisionStepYear(-1)" aria-label="Previous year"${yr<=years[0]?' disabled':''}>◀</button>
      <select id="decisionYearPick" onchange="decisionSelectYear(Number(this.value),false)">${years.map(y=>`<option value="${y}"${y===yr?' selected':''}>${y}</option>`).join('')}</select>
      <button type="button" onclick="decisionStepYear(1)" aria-label="Next year"${yr>=years[years.length-1]?' disabled':''}>▶</button>
      <span>${(()=>{const k=Array.from({length:P.numKids},(_,i)=>yr-P['kid'+(i+1)+'Birth']).filter(x=>x>=0);
        return k.length?`${k.length} ${k.length===1?'child':'children'} · age${k.length===1?'':'s'} ${k.join(', ')}`:'before the kids arrive';})()}${yr===params.homePurchaseYear?' · home purchase':''}</span>
    </div>
    <table class="dr-comparison"><thead><tr><th>Measure</th><th>Current</th><th>Preview</th><th>Change</th></tr></thead><tbody>
    ${rows.map(r=>r[0]==='head'
      ? `<tr class="dr-group"><th colspan="4">${decisionEsc(r[1])}</th></tr>`
      : `<tr><th>${r[0]}</th><td>${r[1]}</td><td>${r[2]}</td>${r[3]}</tr>`).join('')}
    </tbody></table><div class="dr-changes">${changed.length?changed.map(k=>`<div>${decisionEsc(PlannerDecisions.fields[k]?.label||'Nancy’s starting clients')} <strong>${PlannerDecisions.fields[k]?decisionValue(k,P[k])+' → '+decisionValue(k,params[k]):P[k]+' → '+params[k]}</strong></div>`).join(''):'Move a slider or choose a starting point to compare the impact.'}</div>`;
  document.getElementById('decisionSave').disabled=!changed.length||decisionSaving;
  const row=b.current;
  const family=Array.from({length:P.numKids},(_,i)=>({n:i+1,age:row.yr-P['kid'+(i+1)+'Birth']})).filter(k=>k.age>=0);
  document.getElementById('decisionYearDetail').innerHTML=`<div class="dr-kicker">${changed.length?'PREVIEW':'CURRENT PLAN'} / ${row.yr}</div><h4>${family.length?family.map(k=>'Kid '+k.n+' · '+(k.age===0?'newborn':'age '+k.age)).join('<br>'):'Before the kids arrive'}</h4><dl><div><dt>Net worth</dt><dd>${fmt(decisionDollars(row.netWorth,row.yr))}</dd></div><div><dt>of which retirement</dt><dd>${fmt(decisionDollars(row.k401,row.yr))}</dd></div><div><dt>Liquid assets</dt><dd>${fmt(decisionDollars(row.liq,row.yr))}</dd></div><div><dt>Net flow / month</dt><dd class="${row.flow<0?'dr-negative':''}">${decisionMoney(decisionDollars(row.flowMonthly,row.yr))}</dd></div><div><dt>Vest sold to cover</dt><dd>${row.gap>0?fmt(decisionDollars(row.gap,row.yr)):'None needed'}</dd></div><div><dt>Education + care / yr</dt><dd>${fmt(decisionDollars(row.tu+row.cc,row.yr))}</dd></div></dl><p>${row.yr===params.homePurchaseYear?`${fmt(b.down)} down payment this year, separate from monthly margin.`:row.yr>params.homePurchaseYear?'Homeowner phase':'Renting phase'}</p>`;
  decisionRenderChart(base,preview,changed.length>0);
}
function decisionRenderChart(base,preview,changed){
  const W=760,H=215,left=60,right=18,top=16,bottom=30;
  // Total net worth, retirement included — the same series the Trajectory tab and the
  // cockpit plot. This chart was previously aligned DOWN to the Trajectory tab's ex-
  // retirement figure; that tab was the one in the wrong, and both now read r.netWorth.
  const series=rows=>rows.map(r=>decisionDollars(r.netWorth,r.yr));
  const av=series(base),bv=series(preview),min=Math.min(0,...av,...bv),max=Math.max(1,...av,...bv),span=max-min;
  const x=i=>left+i/Math.max(1,base.length-1)*(W-left-right),y=v=>top+(max-v)/span*(H-top-bottom);
  const path=values=>values.map((v,i)=>(i?'L':'M')+x(i).toFixed(2)+','+y(v).toFixed(2)).join(' ');
  const selected=Math.max(0,base.findIndex(r=>r.yr===decisionYear));
  const ticks=[0,.5,1].map(t=>{const value=min+t*span;return `<line x1="${left}" x2="${W-right}" y1="${y(value)}" y2="${y(value)}" stroke="#e2e8f0"/><text x="${left-10}" y="${y(value)+4}" text-anchor="end">${fmt(value)}</text>`;}).join('');
  const labels=[...new Set([0,Math.floor((base.length-1)/2),base.length-1])].map(i=>`<text x="${x(i)}" y="${H-5}" text-anchor="middle">${base[i].yr}</text>`).join('');
  document.getElementById('decisionChart').innerHTML=`<svg class="dr-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Projected net worth from ${base[0].yr} to ${base[base.length-1].yr}. Current plan ends at ${fmt(av[av.length-1])}${changed?', preview at '+fmt(bv[bv.length-1]):''}."><defs><linearGradient id="drFill" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#635bff" stop-opacity=".18"/><stop offset="1" stop-color="#635bff" stop-opacity="0"/></linearGradient></defs>${ticks}<path d="${path(av)} L${x(base.length-1)},${H-bottom} L${left},${H-bottom} Z" fill="url(#drFill)"/><path d="${path(av)}" fill="none" stroke="#635bff" stroke-width="3"/>${changed?`<path d="${path(bv)}" fill="none" stroke="#008c87" stroke-width="3" stroke-dasharray="7 4"/>`:''}<line x1="${x(selected)}" x2="${x(selected)}" y1="${top}" y2="${H-bottom}" stroke="#64748b" stroke-dasharray="3 4"/><circle cx="${x(selected)}" cy="${y(bv[selected])}" r="5" fill="${changed?'#008c87':'#635bff'}" stroke="white" stroke-width="2"/>${labels}</svg><div class="dr-legend"><span>━ Current plan</span>${changed?'<span>┄ What-if preview</span>':''}<span>Net worth includes retirement</span></div>`;
}
async function decisionSaveScenario(){
  if(decisionSaving)return;
  const params={...decisionContext.params};
  if(!Object.keys(params).some(k=>params[k]!==P[k]))return;
  const name=document.getElementById('decisionName').value.trim()||'What-if scenario';
  const scenario={id:advUuid(),name,color:COLORS[scenarios.length%COLORS.length],params,results:run(params)};
  decisionSaving=true;document.getElementById('decisionSave').disabled=true;
  document.getElementById('decisionSaveStatus').textContent='Saving scenario…';
  try{
    const response=await fetch('/api/scenarios',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(scenario)});
    if(!response.ok)throw new Error('HTTP '+response.status);
    scenarios.push(scenario);
    showToast('Scenario saved. Your current plan is unchanged.','green');
    if(activeTab==='home'){render();document.getElementById('decisionSaveStatus').textContent='Saved. Open Compare to view it beside your current plan.';}
  }catch(e){
    if(activeTab==='home')document.getElementById('decisionSaveStatus').textContent='Could not save ('+e.message+'). Your preview is still here. Try again.';
  }finally{decisionSaving=false;const button=document.getElementById('decisionSave');if(button)button.disabled=!Object.keys(decisionContext.params).some(k=>decisionContext.params[k]!==P[k]);}
}
function decisionAsk(kind){
  const context=decisionContext;
  const base=PlannerDecisions.summarize(P,context.R,decisionYear);
  const next=PlannerDecisions.summarize(context.params,context.preview,decisionYear);
  const changes=Object.keys(context.params).filter(k=>context.params[k]!==P[k]).map(k=>`${k}: ${P[k]} → ${context.params[k]}`).join('; ');
  const question=kind==='variant'&&changes?`Help us think through this what-if: ${changes}. The existing model projects ${decisionMoney(next.netWorth-base.netWorth)} change in ${base.last.yr} net worth (excluding the 401k, which is reported separately), ${next.deficitYears} deficit years, and a ${decisionMoney(next.floor.liq)} liquid floor in ${next.floor.yr}. Explain the family-time and financial trade-offs, the assumptions that matter, and one next step. These are scenario projections, not verified account balances. Do not apply changes.`:`Give us a concise decision brief from our current plan: the next family or housing decision, our tightest cash-flow year by net flow (${base.tightest.yr}, ${decisionMoney(base.tightest.flowMonthly)}/month), and one useful action. Separate model assumptions from verified live data. Do not apply changes.`;
  setTab('advisor');
  const input=document.getElementById('advInput');
  if(input){input.value=question;input.style.height='120px';input.focus();input.scrollIntoView({block:'center',behavior:_reduceMotion()?'auto':'smooth'});showToast('Question prepared. Review it, then press Send.','green');}
}
