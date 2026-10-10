'use strict';
// Presentation layer. All values come from the existing model and import modules.
let experienceHousingView='afford';
let lifeYear=null,lifeMode='wealth',lifeContext=null;
let budgetRankMode='size';
let budgetShowAll=false;
let spendingStoryView='categories';
// Optional liquidity lens only: never modifies the underlying compensation or equity.
let overviewIncomeView='flex';
function setOverviewIncomeView(mode){
  if(!['income','cash','flex'].includes(mode))return;
  overviewIncomeView=mode;render();
}
const OVERVIEW_ARG_LEVELS={
  conservative:[[2028,80000],[2030,100000]],
  base:[[2028,80000],[2029,100000],[2035,150000]],
  optimistic:[[2028,100000],[2033,150000]]
};
function overviewArgScenario(){
  const name=typeof scenarios!=='undefined'&&activeScenarioIdx>=0?
    String(scenarios[activeScenarioIdx]?.name||''):'Base Case';
  if(/^conservative(?: case| scenario| plan)?$/i.test(name))return 'conservative';
  if(/^optimistic(?: case| scenario| plan)?$/i.test(name))return 'optimistic';
  return 'base';
}
function overviewArgAvailability(r){
  const year=Number(r.yr),stock=Math.max(0,Number(r.normStock)||0);
  if(year<2028||!stock)return{gross:0,net:0,retain:0};
  const levels=OVERVIEW_ARG_LEVELS[overviewArgScenario()];
  const tier=levels.filter(v=>year>=v[0]).at(-1);
  const gross=Math.min(stock,tier?tier[1]:0);
  const vest=Number(r.sVestRate);
  const retain=Number.isFinite(vest)?Math.max(0,Math.min(1,1-vest)):
    (stock?Math.max(0,Math.min(1,(Number(r.sIncomeNet)||0)/stock)):0);
  return{gross,net:gross*retain,retain};
}
function overviewIncomeRow(r,mode='flex'){
  const cash=Number(r.incFull)||0,total=Number(r.netTC)||0,spent=Number(r.totEFull)||0;
  const arg=overviewArgAvailability(r);
  // The optional cash election RECLASSIFIES after-tax equity; it never adds
  // income beyond total after-tax compensation or changes PEG.
  const flex=Math.max(cash,Math.min(total,cash+arg.net));
  const available=mode==='cash'?cash:mode==='income'?total:flex;
  return{row:r,cash,total,spent,arg,flex,available,margin:available-spent,
    cashGap:Math.max(0,spent-cash),residual:Math.max(0,spent-flex),
    status:cash>=spent?'cash':flex>=spent?'arg':'extra'};
}
function experienceIncomeReadout(rows,mode='flex'){
  const details=rows.map(r=>overviewIncomeRow(r,mode));
  const pressureDetail=details.reduce((a,b)=>deflate(b.margin,b.row.yr)<deflate(a.margin,a.row.yr)?b:a);
  const gaps=details.filter(d=>d.margin<0);
  const counts={cash:0,arg:0,extra:0};details.forEach(d=>counts[d.status]++);
  return{pressure:pressureDetail.row,pressureDetail,gaps,details,counts,
    monthly:Math.abs(pressureDetail.margin)/12};
}
const experienceFolds=new Set();
const experienceEscape=s=>UI.escapeHtml(s);
const experienceMoney=v=>UI.money(v,{exact:Math.abs(v)<10000});
function experienceMetric(label,value,note,tone=''){
  return `<div class="ex-metric ${tone}"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
}
function experienceHeader(kicker,title,description,action=''){
  return `<header class="ex-heading"><div><span class="ex-kicker">${kicker}</span><h2>${title}</h2><p>${description}</p></div>${action}</header>`;
}
function experienceFold(parent,nodes,title,key){
  const items=[...nodes].filter(Boolean);if(!items.length)return null;
  const d=document.createElement('details');d.className='ex-detail';d.dataset.fold=key;
  d.open=experienceFolds.has(key);
  const s=document.createElement('summary');s.textContent=title;d.append(s);
  const body=document.createElement('div');body.className='ex-detail-body';d.append(body);
  items[0].before(d);items.forEach(n=>body.append(n));
  d.addEventListener('toggle',()=>{if(d.open)experienceFolds.add(key);else experienceFolds.delete(key);});
  return d;
}
function experienceUtility(tab,sub){
  if(sub){if(tab==='today')_todayView=sub;else if(tab==='stripe')_stripeView=sub;}
  setTab(tab);window.scrollTo({top:0,behavior:'instant'});
}
function experienceNavigation(){
  const tabs=document.querySelector('.tabs');if(!tabs)return;
  const utilityToday=activeTab==='today'&&!['spending','budget'].includes(_todayView);
  const primary=[['cockpit','target','Overview'],['today','card','Spending & Budget'],['projection','chart','Future'],['home','home','Decisions'],['advisor','spark','Advisor']];
  tabs.innerHTML=`<div class="ex-rail-label">YOUR PRIVATE OFFICE</div>`+primary.map(([key,icon,label])=>{
    const on=activeTab===key&&!utilityToday;
    return `<button role="tab" data-tab="${key}" aria-selected="${on}" class="${on?'active':''}" onclick="${key==='today'?"experienceUtility('today','spending')":`experienceUtility('${key}')`}">${UI.icon(icon)}<span>${label}</span></button>`;
  }).join('')+`<div class="ex-rail-label ex-rail-secondary">DETAILS & SOURCES</div>
    <button class="ex-utility ${utilityToday&&_todayView==='overview'?'selected':''}" onclick="experienceUtility('today','overview')">${UI.icon('circle')}<span>Accounts & holdings</span></button>
    <button class="ex-utility ${activeTab==='stripe'?'selected':''}" onclick="experienceUtility('stripe')">${UI.icon('diamond')}<span>Stripe equity</span></button>
    <button class="ex-utility ${utilityToday&&_todayView==='watch'?'selected':''}" onclick="experienceUtility('today','watch')">${UI.icon('bell')}<span>Watchlist</span><span class="nav-badge" id="navAlertBadge" hidden></span></button>
    <button class="ex-utility ${activeTab==='inputs'?'selected':''}" onclick="experienceUtility('inputs')">${UI.icon('gear')}<span>Plan assumptions</span></button>
    <div class="ex-rail-bottom"><button onclick="openGuidedWalkthrough()">${UI.icon('spark')}<span>Guided walkthrough</span></button><button id="moreBtn" aria-label="Present and export" aria-haspopup="true" aria-expanded="false" onclick="toggleMoreMenu(event)">${UI.icon('doc')}<span>Present & export</span></button><div id="navLive" hidden></div></div>`;
  const st=document.getElementById('subToggle');
  if(activeTab==='today'){
    const views=utilityToday?[['overview','Accounts'],['holdings','Holdings'],['watch','Watchlist']]:[['spending','Spending'],['budget','Budget']];
    st.innerHTML=views.map(([v,l])=>`<button aria-pressed="${_todayView===v}" class="${_todayView===v?'active':''}" onclick="setSubView('${v}')">${l}</button>`).join('');
  }
  if(activeTab==='projection'){
    st.innerHTML=[['life','Life timeline'],['nw','Wealth'],['income','Income & tax'],['cashflow','Cash flow'],['table','Table']].map(([v,l])=>`<button aria-pressed="${_projView===v}" class="${_projView===v?'active':''}" onclick="setSubView('${v}')">${l}</button>`).join('');
  }
  if(activeTab==='home')st.innerHTML=[['explore','What-if'],['housing','Housing'],['compare','Compare']].map(([v,l])=>`<button aria-pressed="${_homeView===v}" class="${_homeView===v?'active':''}" onclick="setSubView('${v}')">${l}</button>`).join('');
  try{renderNavLive();}catch(_){}
  document.querySelector('.nav-spark')?.remove();
  if(!document.getElementById('exMobileDetails')){const b=document.createElement('button');b.id='exMobileDetails';b.className='ui-btn';b.textContent='Details & tools';b.onclick=experienceMobileTools;document.querySelector('.hdr-right')?.append(b);}
  document.querySelector('.brand h1')?.setAttribute('aria-label','Cohen Family Private Office');
}
function experienceOverview(R){
  const cp=document.querySelector('.cockpit');if(!cp)return;
  cp.classList.add('so-briefing');
  const current=R.find(r=>r.yr===PlannerTime.year())||R[0];
  const years=R.filter(r=>r.yr>=current.yr),cashOnly=overviewIncomeView==='cash',flexView=overviewIncomeView==='flex';
  const {pressure,pressureDetail,gaps,monthly,counts}=experienceIncomeReadout(years,overviewIncomeView);
  const basis=cashOnly?'cash pay':flexView?'cash + ARG':'income';
  const heading=cp.querySelector('.cp-heading');
  heading.querySelector('h2').textContent='Your financial briefing.';
  const now=cp.querySelector('.cp-register[data-tense="now"]');
  const metrics=now.querySelector('.cp-metrics'),allMetrics=[...metrics.children];
  const details=allMetrics.filter(n=>!['Cash + taxable','Vested Stripe'].includes(n.querySelector('span')?.textContent));
  if(details.length){const more=document.createElement('div');more.className='so-position-detail';details.forEach(n=>more.append(n));now.append(more);experienceFold(now,[more],'Other balances & current cash margin','briefing-position');}
  const brief=document.createElement('section');brief.className='so-story';
  const headline=flexView?(counts.extra?'ARG gives flexibility, but some years need more.':counts.arg?'ARG gives you flexibility in tighter years.':'Cash pay covers your modeled lifestyle.'):
    gaps.length?(cashOnly?'Some years need more than cash pay.':'Some years outspend your income.'):(cashOnly?'Cash pay covers your modeled lifestyle.':'Income covers your modeled lifestyle.');
  const description=flexView?`${counts.cash} of ${years.length} years covered by cash pay · ${counts.arg} more potentially covered by ARG · ${counts.extra} requiring additional funding.`:
    gaps.length?`${gaps.length} of ${years.length} modeled years spend more than after-tax ${basis}.`:`After-tax ${basis} covers spending in all ${years.length} modeled years.`;
  const unit=inflationView?'today’s dollars ('+P.planStartYear+')':'future dollars';
  brief.innerHTML=`<div class="so-story-copy"><span class="so-eyebrow">THE PLAN IN ONE MINUTE</span><div class="ex-segments so-income-toggle" role="group" aria-label="Income comparison"><button aria-pressed="${cashOnly}" onclick="setOverviewIncomeView('cash')">Cash pay</button><button aria-pressed="${flexView}" onclick="setOverviewIncomeView('flex')">Cash + ARG</button><button aria-pressed="${overviewIncomeView==='income'}" onclick="setOverviewIncomeView('income')">Total comp</button></div><h2>${headline}</h2><p>${description}</p><div class="so-story-actions"><button onclick="lifeOpenYear(${pressure.yr})">Explore the tightest year <span>↗</span></button><button onclick="_homeView='explore';experienceUtility('home')">Test a different outcome</button></div></div><div class="so-key-number"><span>${gaps.length?'Largest monthly '+basis+' gap':'Smallest monthly '+basis+' surplus'}</span><strong>${experienceMoney(deflate(monthly,pressure.yr))}</strong><span>${pressure.yr} · ${unit}</span><small>${flexView?'Optional after-tax ARG election capacity; no actual cash election assumed.':cashOnly?'Cash pay only · excludes stock compensation.':'After-tax compensation · includes stock pay.'}<br>Excludes investment returns and existing assets.</small></div><div class="so-cash-path"><div class="so-path-head"><span>WHEN ${cashOnly?'CASH PAY':flexView?'CASH PAY + ARG':'INCOME'} COVERS YOUR LIFE</span><span>Annual ${basis} less spending · ${unit}</span></div>${experienceCashPath(years,pressure.yr,overviewIncomeView)}<div class="so-path-key">${flexView?'<span><i class="so-key-cash"></i>Cash pay covers</span><span><i class="so-key-arg"></i>ARG could bridge</span><span><i class="so-key-extra"></i>More funding needed</span>':`<span><i class="so-key-cash"></i>${cashOnly?'Cash':'Income'} remaining</span><span><i class="so-key-short"></i>Spending above ${basis}</span>`}<span>Choose a year to explore</span></div></div>`;
  if(flexView){
    const top=brief.querySelector('.so-key-number');
    const annualGap=pressureDetail.cashGap,available=pressureDetail.arg.net,residual=pressureDetail.residual;
    const annual=v=>experienceMoney(deflate(v,pressure.yr));
    const grossNeeded=pressureDetail.arg.retain>0?Math.min(pressureDetail.arg.gross,annualGap/pressureDetail.arg.retain):0;
    top.querySelector('small')?.remove();
    top.insertAdjacentHTML('beforeend',`<div class="so-arg-breakdown">
      <div><span>Cash-only annual gap</span><strong>${annual(annualGap)}</strong></div>
      <div><span>Potential after-tax ARG</span><strong>${annual(available)}</strong></div>
      <div><span>Remaining annual gap</span><strong>${annual(residual)}</strong></div>
    </div><small>${pressureDetail.arg.gross>0?`To cover the cash-only gap, up to ${annual(grossNeeded)} of gross ARG could be elected if permitted in that amount.`:'No ARG cash election is modeled in this year.'} Elections may require advance notice or fixed increments. The saved plan still retains ARG as stock.</small>`);
    brief.querySelector('.so-story-actions')?.insertAdjacentHTML('beforebegin',
      '<p class="so-arg-intro">Optional cash capacity only. Performance awards remain stock; no election or share sale is triggered.</p>');
    brief.querySelector('.so-cash-path')?.insertAdjacentHTML('beforeend',
      '<p class="so-arg-disclosure">This view estimates ARG from your selected compensation case (Base for Live plan) and carries the last known grant target past 2037. It does not change projected cash flows or net worth. Full-year, after-tax approximations; PEG is not cash-electable.</p>');
  }
  now.after(brief);
  const decision=document.createElement('section');decision.className='so-decision';
  const buying=P.housingMode!=='rent'&&years.some(r=>r.yr===P.homePurchaseYear);
  decision.innerHTML=`<div><span class="ex-kicker">YOUR NEXT QUESTION</span><h3>${buying?'How much home leaves room for the rest of your life?':gaps.length?(cashOnly?'How much of your lifestyle depends on stock pay?':'Which years need income or spending changes?'):'What would make this plan less comfortable?'}</h3><p>${buying?'Put the purchase beside family costs, peak tuition and your cash reserves.':gaps.length?(cashOnly?'Explore grant elections, liquidity and Stripe sale timing.':'Review compensation, family costs and the assumptions behind your income.'):'Stress income, markets and spending before treating the projection as a promise.'}</p></div><button class="ui-btn ui-btn-primary" onclick="${buying?"_homeView='housing';experienceUtility('home')":"_homeView='explore';experienceUtility('home')"}">${buying?'Explore housing':'Stress the plan'} ↗</button>`;
  brief.after(decision);
  const workspace=cp.querySelector('.cp-workspace'),runway=cp.querySelector('section[aria-label="Cash runway and required Stripe sales"]');
  workspace?.querySelector('.cp-floor')?.remove();workspace?.querySelector('.cp-intelligence')?.remove();
  // Keep accounting and watchlist evidence reachable without repeating Future on the landing screen.
  if(workspace){const fold=experienceFold(cp,[workspace],'Projection details & watchlist evidence','briefing-evidence');fold.addEventListener('toggle',()=>{if(fold.open)charts.cockpit?.resize?.();});}
  if(runway){cp.append(runway);experienceFold(cp,[runway],'Liquidity runway & planned equity sales','overview-runway');}
  const signal=document.createElement('div');signal.className='so-watch-note';
  const priorities=_inbox?.priorities||[];
  signal.innerHTML=`<span>${_inboxError?'Watchlist checks unavailable':!_inbox?'Reading watchlist checks…':priorities.length?experienceEscape(priorities[0].title||priorities[0].kind||'A watchlist item needs review'):'No priorities returned by the checks that ran.'}</span><button onclick="experienceUtility('today','watch')">Review checks${priorities.length?' ('+priorities.length+')':''} ↗</button>`;
  decision.after(signal);
}
function experienceCashPath(rows,selected,mode='cash'){
  const basis=mode==='cash'?'cash':mode==='flex'?'cash + ARG':'income';
  const analyzed=rows.map(r=>overviewIncomeRow(r,mode));
  const values=analyzed.map(d=>deflate(d.margin,d.row.yr));
  const pos=Math.max(0,...values),neg=Math.min(0,...values),span=Math.max(1,pos-neg);
  const top=22,bottom=155,height=bottom-top,zero=top+pos/span*height;
  const count=rows.length,step=820/Math.max(1,count),width=Math.max(4,step*.65);
  const y=v=>top+(pos-v)/span*height;
  const bars=rows.map((r,i)=>{const v=values[i],x=58+(i+.5)*step,yy=y(v),h=Math.max(1,Math.abs(yy-zero));
    const status=analyzed[i].status;
    const label=`${r.yr}: ${experienceMoney(Math.abs(v))} annual ${basis} ${v<0?'shortfall':'surplus'}. ${mode==='flex'?(status==='cash'?'Cash pay covers spending.':status==='arg'?'Electable ARG could bridge the gap.':'Additional funding is required.'):'Excludes investment returns and existing asset sales.'} No actual ARG cash election is assumed.`;
    return `<g class="so-year" role="button" tabindex="0" aria-label="${label}. Explore year" onclick="lifeOpenYear(${r.yr})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();lifeOpenYear(${r.yr});}"><title>${label}</title><rect x="${x-step/2}" y="15" width="${step}" height="165" fill="transparent"/><rect class="so-year-bar" x="${x-width/2}" y="${Math.min(yy,zero)}" width="${width}" height="${h}" rx="2" fill="${mode==='flex'?(analyzed[i].status==='cash'?'#397d79':analyzed[i].status==='arg'?'#b27b43':'#a45447'):(v<0?'#b27b43':'#397d79')}" opacity="${r.yr===selected?1:.7}"/>${r.yr===selected?`<circle cx="${x}" cy="${v<0?yy+7:yy-7}" r="3" fill="#283c45"/>`:''}</g>`;}).join('');
  const ticks=[...new Set([0,Math.floor((count-1)/2),count-1])];
  return `<svg class="so-cash-svg" viewBox="0 0 910 205" role="group" aria-label="Annual ${basis} surplus and shortfall by year. Each bar opens that year."><text x="0" y="${top+4}">${experienceMoney(pos)}</text>${neg<0?`<text x="0" y="${bottom+4}">${experienceMoney(neg)}</text>`:''}<line x1="58" x2="878" y1="${zero}" y2="${zero}" stroke="#8faaa8" stroke-width="1"/><text x="884" y="${Math.max(12,zero+4)}">$0</text>${bars}${ticks.map(i=>`<text x="${58+(i+.5)*step}" y="195" text-anchor="middle">${rows[i].yr}</text>`).join('')}</svg>`;
}

function lifeOpenYear(year){lifeYear=year;_projView='life';experienceUtility('projection');}
function renderLifeTimeline(R){
  destroyCharts();
  lifeYear=Math.max(R[0].yr,Math.min(R.at(-1).yr,lifeYear??PlannerTime.year()));
  lifeContext={R};
  const events=cockpitMilestones(R,P);
  const floor=R.reduce((a,b)=>b.liq<a.liq?b:a),peak=R.reduce((a,b)=>b.tuFull>a.tuFull?b:a);
  const value=lifeMode==='wealth'?'Year-end wealth':'Monthly surplus / shortfall before equity sales';
  document.getElementById('chartArea').innerHTML=`<div class="life-workspace">
    ${experienceHeader('FUTURE / LIFE TIMELINE','Your life. In perspective.','Follow the years, see the pressure points, and understand how your choices shape the path.')}
    <section class="ex-panel life-chart-panel"><div class="ex-panel-head"><div><span class="ex-kicker">${value}</span><h3 id="lifeChartValue"></h3><p>Projected · ${experienceEscape(scenarios[activeScenarioIdx]?.name||'Working plan')} · ${inflationView?'today’s dollars ('+P.planStartYear+')':'future dollars'}</p></div>
      <div class="ex-segments" aria-label="Timeline chart mode"><button aria-pressed="${lifeMode==='wealth'}" onclick="lifeSetMode('wealth')">Wealth</button><button aria-pressed="${lifeMode==='cash'}" onclick="lifeSetMode('cash')">Cash flow</button></div></div>
    <div class="life-chart"><canvas id="lifeChart" role="img" aria-label="Projected wealth or annual cash flow across your life timeline"></canvas></div>
    <div class="life-legend" id="lifeLegend"></div>
    <div class="life-scrubber"><button onclick="lifeSelectYear(lifeYear-1)" aria-label="Previous year">‹</button><output id="lifeYearLabel">${lifeYear}</output><input id="lifeYearRange" type="range" min="${R[0].yr}" max="${R.at(-1).yr}" value="${lifeYear}" aria-label="Explore a year" oninput="lifeSelectYear(Number(this.value))"><button onclick="lifeSelectYear(lifeYear+1)" aria-label="Next year">›</button></div>
    <div class="life-jumps"><span>Jump to</span><button onclick="lifeSelectYear(${floor.yr})">Lowest liquidity · ${floor.yr}</button><button onclick="lifeSelectYear(${peak.yr})">Peak tuition · ${peak.yr}</button>${P.housingMode!=='rent'&&R.some(r=>r.yr===P.homePurchaseYear)?`<button onclick="lifeSelectYear(${P.homePurchaseYear})">Home purchase · ${P.homePurchaseYear}</button>`:''}</div></section>
    <section class="ex-panel life-year-panel"><div class="ex-panel-head"><div><span class="ex-kicker">THE SELECTED YEAR</span><h3 id="lifeChapter"></h3></div><span class="ex-context-pill" id="lifeHome"></span></div><div id="lifeFamily" class="life-family"></div><div id="lifeMetrics" class="ex-answer-band"></div><div id="lifeCashBridge" class="ex-cash-bridge"></div><div id="lifeInsight" class="life-insight"></div><div class="life-year-actions"><button class="ui-btn" onclick="_budgetYear=lifeYear;experienceUtility('today','budget')">Inspect this year’s budget ↗</button><button class="ui-btn" onclick="decisionYear=lifeYear;_homeView='explore';experienceUtility('home')">Test a decision ↗</button><button class="ui-btn" onclick="cockpitQuestion('Review '+lifeYear+' in my current plan. Explain cash pay, spending, required asset sales and the assumptions most worth checking.')">Ask the advisor ↗</button></div></section>
    <details class="ex-detail"><summary>All life milestones</summary><div class="ex-detail-body life-events">${events.map(e=>`<button onclick="lifeSelectYear(${e.yr})"><strong>${e.yr}</strong><span>${experienceEscape(e.label)}${e.extra?' +'+e.extra:''}</span></button>`).join('')}</div></details>
    <details class="ex-detail"><summary>What this projection includes</summary><div class="ex-detail-body"><p>Year-end wealth includes diversified liquid investments, vested Stripe, home equity, other modeled assets and retirement, less debt. Cash flow shows whole-year after-tax cash pay and spending; equity sales can fund a shortfall. First-year balances grow only for the period after the opening observation. Returns are assumptions. Employment and contributions continue through the modeled horizon; this is not a retirement withdrawal simulation.</p><button class="ui-btn" onclick="setSubView('table')">Open annual table</button></div></details></div>`;
  const colors={total:'#315c45',liquid:'#829575',cash:'#366855',spend:'#a47f50'};
  const datasets=lifeMode==='wealth'?[
    {label:'Total net worth · incl. retirement',data:R.map(r=>deflate(r.netWorth,r.yr)),borderColor:colors.total,fill:true,backgroundColor:ctx=>{const ch=ctx.chart,area=ch.chartArea;if(!area)return 'rgba(72,106,76,.06)';const g=ch.ctx.createLinearGradient(0,area.top,0,area.bottom);g.addColorStop(0,'rgba(72,106,76,.18)');g.addColorStop(1,'rgba(72,106,76,0)');return g;}},
    {label:'Liquid investments',data:R.map(r=>deflate(r.liq,r.yr)),borderColor:colors.liquid,borderDash:[4,4]}]:[
    {label:'Annual after-tax cash pay',data:R.map(r=>deflate(r.incFull,r.yr)),borderColor:colors.cash},
    {label:'Annual spending',data:R.map(r=>deflate(r.totEFull,r.yr)),borderColor:colors.spend,fill:'-1',backgroundColor:'rgba(164,127,80,.06)'}];
  document.getElementById('lifeLegend').innerHTML=datasets.map(d=>`<span><i style="background:${d.borderColor}"></i>${d.label}</span>`).join('');
  const cursor={id:'lifeCursor',afterDatasetsDraw(ch){const idx=R.findIndex(r=>r.yr===lifeYear),x=ch.scales.x.getPixelForValue(idx);const{ctx,chartArea:a}=ch;ctx.save();ctx.strokeStyle='#53714f';ctx.setLineDash([3,5]);ctx.beginPath();ctx.moveTo(x,a.top);ctx.lineTo(x,a.bottom);ctx.stroke();ctx.setLineDash([]);for(let i=0;i<datasets.length;i++){const point=ch.getDatasetMeta(i).data[idx];if(point){ctx.fillStyle=datasets[i].borderColor;ctx.beginPath();ctx.arc(point.x,point.y,5,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#101724';ctx.lineWidth=3;ctx.stroke();}}ctx.restore();}};
  charts.main=new Chart(document.getElementById('lifeChart'),{type:'line',data:{labels:R.map(r=>String(r.yr)),datasets:datasets.map(d=>({...d,tension:.27,borderWidth:2.5,pointRadius:0,pointHitRadius:14}))},plugins:[cursor],options:{responsive:true,maintainAspectRatio:false,animation:_reduceMotion()?false:{duration:450},interaction:{mode:'index',intersect:false},onClick:(e,els,ch)=>{if(els.length)lifeSelectYear(R[els[0].index].yr);else{const idx=Math.max(0,Math.min(R.length-1,Math.round(ch.scales.x.getValueForPixel(e.x))));lifeSelectYear(R[idx].yr);}},plugins:{legend:{display:false},datalabels:{display:false},tooltip:{backgroundColor:'#193b2c',titleColor:'#f0f2f6',bodyColor:'#c5cede',padding:14,callbacks:{label:c=>c.dataset.label+': '+experienceMoney(c.parsed.y)}}},scales:{x:{grid:{display:false},ticks:{color:'#62715b',maxTicksLimit:8,font:{size:12}}},y:{grid:{color:'rgba(41,70,45,.10)'},ticks:{color:'#62715b',callback:v=>experienceMoney(v),maxTicksLimit:5,font:{size:12}}}}}});
  lifeSelectYear(lifeYear);
}
function lifeSetMode(mode){lifeMode=mode;render();}
function lifeSelectYear(year){
  if(!lifeContext)return;const R=lifeContext.R;
  lifeYear=Math.max(R[0].yr,Math.min(R.at(-1).yr,Number(year)));const r=R.find(x=>x.yr===lifeYear);if(!r)return;
  document.getElementById('lifeYearRange').value=lifeYear;document.getElementById('lifeYearLabel').textContent=lifeYear;
  const cash=(r.incFull-r.totEFull)/12;
  document.getElementById('lifeChartValue').textContent=lifeMode==='wealth'?experienceMoney(deflate(r.netWorth,r.yr)):experienceMoney(deflate(cash,r.yr))+' / month';
  const milestone=PlannerDecisions.milestones(P,R).filter(x=>x.yr===lifeYear);
  document.getElementById('lifeChapter').textContent=lifeYear+(milestone.length?' · '+milestone.map(x=>x.label).join(' / '):' · Your household');
  const bought=P.housingMode!=='rent'&&lifeYear>=P.homePurchaseYear;
  document.getElementById('lifeHome').textContent=bought?'Owning your home':'Renting';
  document.getElementById('lifeFamily').innerHTML=Array.from({length:P.numKids},(_,i)=>{const age=lifeYear-P['kid'+(i+1)+'Birth'];return `<span class="life-person ${age<0?'future':''}">${UI.icon('circle')}<b>Child ${i+1}</b><small>${age<0?'Arrives '+P['kid'+(i+1)+'Birth']:age===0?'Newborn':'Age '+age}</small></span>`;}).join('');
  const at=v=>experienceMoney(deflate(v,lifeYear));
  document.getElementById('lifeMetrics').innerHTML=experienceMetric('After-tax cash pay',at(r.incFull/12),'Per month · excludes unsold equity')+experienceMetric('Household spending',at(r.totEFull/12),`Per month · tuition ${at(r.tuFull/12)}`)+experienceMetric('Cash surplus / shortfall',at(cash),'Per month · before selling equity',cash<0?'warn':'')+experienceMetric('Liquid investments',at(r.liq),'Year-end · cash + taxable investments');
  document.getElementById('lifeInsight').innerHTML=`${UI.icon(cash<0?'alert':'chart')}<div><strong>${cash<0?'Spending exceeds cash pay.':'Cash pay covers modeled spending.'}</strong><p>${cash<0?`The annual cash shortfall is ${at(-cash*12)}. `:''}${r.sSold+r.sHold>0?`${at(r.sSold+r.sHold)} of gross Stripe sales are modeled this year, including funding needs and your sale policy.`:'No gross Stripe sales are modeled for this year.'} ${bought&&lifeYear===P.homePurchaseYear?'The home purchase also uses upfront funds; the monthly surplus excludes the down payment.':''}</p></div>`;
  document.getElementById('lifeCashBridge').innerHTML=experienceCashBridge(r,lifeYear);
  charts.main?.update('none');
}
function experienceBudget(R){
  const bd=document.querySelector('.bd');if(!bd)return;
  const yr=Math.min(R.at(-1).yr,Math.max(R[0].yr,_budgetYear??PlannerTime.year())),r=R.find(x=>x.yr===yr),mo=_budgetUnit==='month';
  const a=PlannerBudget.allocation(P,R,yr),act=yr===PlannerTime.year()?PlannerBudget.actuals(_spend,yr,P.monarchLineMap):null;
  const amt=v=>experienceMoney(v/(mo?12:1));
  bd.querySelector('.bd-head').outerHTML=experienceHeader('SPENDING & BUDGET / PLAN','Your spending, against your plan.',`Household totals · ${yr} · ${mo?'monthly':'annual'} amounts. Housing follows the selected case.`);
  const bar=bd.querySelector('.bd-bar');
  const tools=bar?.querySelector('.bd-tools');if(tools){const advanced=document.createElement('details');advanced.className='ex-budget-settings';advanced.innerHTML='<summary>Budget settings</summary>';tools.before(advanced);advanced.append(tools);}
  const mobileTools=bd.querySelector('.bd-tools-m');if(mobileTools)mobileTools.remove();
  const bucket=bd.querySelector('.bd-buckets');
  const band=document.createElement('section');band.className='ex-answer-band ex-budget-answer';
  band.innerHTML=experienceMetric('Planned spending',amt(r.totEFull),mo?'Per month':'For the whole year')+
    experienceMetric('Actual spending',act?experienceMoney(act.perMonth*(mo?1:12)):'—',act?`${act.months} closed months · ${mo?'monthly average':'annualized pace'}`:'No comparable closed-month records')+
    experienceMetric('Cash invested',amt(a.investing.portfolio),'After spending & emergency savings')+
    experienceMetric('Equity retained',amt(a.investing.stripe),'Stripe kept as shares · not cash');
  bar?.after(band);
  if(bucket)experienceFold(bd,[bucket],'How income is allocated','budget-allocation');
  const rank=document.createElement('section');rank.className='ex-panel ex-budget-chart';
  rank.innerHTML=experienceRankChart(r,act,mo);
  band.after(rank);
  const lines=bd.querySelector('.bd-lines');
  // Income, saving, investing and one-off editors remain available, but spending leads.
  for(const [id,title] of [['income','Income & deductions'],['saving','Emergency savings'],['investing','Investment allocation'],['oneoff','Schedule one-off costs']]){
    const sec=lines?.querySelector('#bd-g-'+id);if(sec)experienceFold(lines,[sec],title,'budget-'+id);
  }
  lines?.querySelector('.bd-bottom')?.remove(); // Duplicate total; the answer band covers it explicitly.
  const planItems=lines?[...lines.querySelectorAll(':scope>.cl-group')].find(n=>n.querySelector('.bd-item')):null;
  if(planItems)experienceFold(lines,[planItems],'Scheduled family expenses & plan items','budget-items');
  lines?.querySelectorAll('.bd-row[data-line]').forEach(row=>{
    const key=row.dataset.line,value=Number(row.dataset.planned),ln=act?.lines[key];
    const actual=ln?.perMonth,planned=value/12,delta=actual==null?null:actual-planned;
    const top=row.querySelector('.cl-top');
    const columns=document.createElement('div');columns.className='ex-budget-actual';
    const important=delta!=null&&delta>Math.max(100,planned*.1);
    columns.innerHTML=`<span>${actual==null?'—':experienceMoney(actual*(mo?1:12))}</span><span class="${important?'warn':''}">${delta==null?'—':UI.money(delta*(mo?1:12),{signed:true,exact:true})}</span><button class="ex-row-more" aria-label="Details for ${experienceEscape(LIV_LABEL[key]||key)}" aria-expanded="false">Details</button>`;
    top.append(columns);
    const rest=[...row.children].filter(n=>n!==top);
    rest.filter(n=>n.matches('.cl-track,.bd-callout')).forEach(n=>n.remove());
    const body=document.createElement('div');body.className='ex-row-detail';body.hidden=true;
    rest.filter(n=>n.isConnected).forEach(n=>body.append(n));
    const guideHtml=experienceBudgetGuideHtml(P,r,key);if(guideHtml)body.insertAdjacentHTML('afterbegin',guideHtml);row.append(body);
    const more=columns.querySelector('button');more.onclick=()=>{body.hidden=!body.hidden;more.setAttribute('aria-expanded',String(!body.hidden));more.textContent=body.hidden?'Details':'Close';};
    const actualStrip=body.querySelector('.bd-actual');if(actualStrip)actualStrip.querySelector('.bd-pill')?.remove();
  });
  for(const sec of bd.querySelectorAll('#bd-g-fixed,#bd-g-discretionary')){
    const cols=document.createElement('div');cols.className='ex-budget-columns';cols.innerHTML='<span>Category</span><span>Planned</span><span>Actual pace</span><span>Difference</span><span></span>';
    sec.querySelector('.cl-list')?.before(cols);
  }
  const below=[...bd.children].filter(n=>n.tagName==='DETAILS'&&!n.classList.contains('ex-detail'));
  const calibration=below.filter(n=>/family like|NYC|Baselines/i.test(n.querySelector('summary')?.textContent||''));
  const remaining=below.filter(n=>!calibration.includes(n));
  if(calibration.length)experienceFold(bd,calibration,'Calibrate your household budget','budget-calibration');
  if(remaining.length)experienceFold(bd,remaining,'Across the years, shared cases & import settings','budget-support');
}
function experienceSpending(){
  const w=document.querySelector('.spending-workspace');if(!w)return;
  w.insertAdjacentHTML('afterbegin',experienceHeader('SPENDING & BUDGET / ACTUALS','Know where your money goes.','Your imported spending, the categories driving it, and how the trend is changing.'));
  const nodes=[...w.children];
  const monthly=w.querySelector('#spendMonthlyChart')?.closest('section');
  if(monthly)experienceFold(w,[monthly],'Monthly income & spending history','spending-monthly');
  // One period selector drives the main category lens. The drift chart retains its own explicit window.
  const averages=nodes.find(n=>/average monthly spending/i.test(n.textContent));
  if(averages)averages.classList.add('ex-spend-averages');
}
function experienceHousingSelect(v){experienceHousingView=v;render();}
function experienceHousing(R){
  const ca=document.getElementById('chartArea'),rb=document.getElementById('homeRB'),hs=document.getElementById('homeHS');if(!rb||!hs)return;
  ca.querySelector('.home-sec')?.remove();
  ca.insertAdjacentHTML('afterbegin',experienceHeader('DECISIONS / HOUSING','Find the home that fits your life.','Explore affordability, monthly costs and renting versus buying with the same assumptions.'));
  const views=document.createElement('div');views.className='ex-housing-tabs ex-segments';views.setAttribute('aria-label','Housing question');
  views.innerHTML=[['afford','How much can we afford?'],['payment','What would it cost?'],['rentbuy','Should we rent or buy?']].map(([v,l])=>`<button aria-pressed="${experienceHousingView===v}" onclick="experienceHousingSelect('${v}')">${l}</button>`).join('');
  ca.querySelector('.ex-heading').after(views);
  rb.hidden=experienceHousingView!=='rentbuy';hs.hidden=experienceHousingView==='rentbuy';
  const q=rbParams(),model=run(q).R,py=q.homePurchaseYear,owned=model.find(r=>r.yr===py),floor=model.reduce((a,b)=>b.liq<a.liq?b:a);
  // These preview controls share the existing rent/buy override state; no saved input is changed.
  const controls=document.createElement('section');controls.className='ex-panel ex-home-controls';
  const keys=['homePrice','homePurchaseYear','downPctg','mortgageRate'];
  controls.innerHTML='<div class="ex-panel-head"><h3>Explore the purchase</h3><span>Preview · apply explicitly</span></div><div class="ex-control-grid">'+keys.map(key=>{
    const f=RB_LEVERS.find(x=>x[0]===key),v=rbVal(key),min=key==='homePurchaseYear'?R[0].yr:Math.min(f[2],v),max=key==='homePurchaseYear'?R.at(-1).yr:Math.max(f[3],v);
    return `<label>${f[1]}<output id="exHome-${key}">${f[5](v)}</output><input type="range" aria-label="${f[1]}" min="${min}" max="${max}" step="${f[4]}" value="${v}" oninput="experienceHomePeek('${key}',this.value)" onchange="rbSet('${key}',this.value)"></label>`;
  }).join('')+'</div><div class="ex-home-live" id="exHomeLive"></div>'+ (Object.keys(_rbOv).length?'<div class="ex-home-apply"><button class="ui-btn ui-btn-primary" onclick="rbApply()">Apply purchase assumptions</button><button class="ui-btn" onclick="rbReset()">Reset preview</button></div>':'');
  views.after(controls);experienceHomePeek();
  const root=hs.firstElementChild;
  if(root){
    const kids=[...root.children];
    // Preserve every affordability, cash-to-close, funding-stress and mortgage tool in contextual folds.
    const timing=kids.filter(n=>/What you can afford, by purchase year/.test(n.textContent));
    const payment=kids.filter(n=>/Monthly cost at/.test(n.textContent));
    const answer=kids[0],limits=kids[1],comfort=kids[2];
    if(experienceHousingView==='payment'){
      [answer,limits,comfort].forEach(n=>{if(n)n.hidden=true;});
      if(payment[0])root.prepend(payment[0]);
    }
    if(timing.length)experienceFold(root,timing,'What changes if we buy later?','home-timing');
    const primary=new Set([answer,limits,comfort,...payment]);
    const support=[...root.children].filter(n=>!primary.has(n)&&n.tagName!=='DETAILS');
    if(support.length)experienceFold(root,support,'Closing funds, liquidity & income-interruption stress','home-funding');
    if(experienceHousingView==='afford'&&payment.length)experienceFold(root,payment,'Monthly payment breakdown','home-payment');
  }
  const rbroot=rb.firstElementChild;
  if(rbroot){
    const children=[...rbroot.children],levers=children.find(n=>n.querySelector('#rb_homePrice'));
    if(levers){
      const market=levers.firstElementChild; if(market)experienceFold(levers,[market],'Market assumptions','home-markets');
      const homegroup=levers.querySelector('#rb_homePrice')?.closest('div')?.parentElement;
      if(homegroup){for(const inp of homegroup.querySelectorAll('input'))if(keys.includes(inp.id.replace('rb_','')))inp.closest('div').hidden=true;}
    }
    const chart=children.find(n=>n.querySelector('#rbChart'));
    const idx=children.indexOf(chart);
    const details=idx<0?[]:children.slice(idx+1);
    if(details.length)experienceFold(rbroot,details,'Breakeven, funding, full comparison & assumptions','home-rentbuy-details');
  }
}
function experienceHomePeek(key,value){
  const q=rbParams();if(key){q[key]=Number(value);const f=RB_LEVERS.find(x=>x[0]===key);document.getElementById('exHome-'+key).textContent=f[5](Number(value));}
  const loan=q.homePrice*(1-q.downPctg/100),mr=q.mortgageRate/1200;
  const pi=loan<=0?0:mr>0?loan*mr/(1-Math.pow(1+mr,-360)):loan/360;
  const cost=pi+(q.propTaxRate??.012)*q.homePrice/12+(q.maintBase||0)/12;
  const el=document.getElementById('exHomeLive');if(el)el.innerHTML=experienceMetric('Monthly carrying cost',experienceMoney(cost),'Principal, interest, property tax & modeled maintenance')+experienceMetric('Down payment',experienceMoney(q.homePrice*q.downPctg/100),'Closing costs and sale taxes are additional')+experienceMetric('Purchase year',q.homePurchaseYear,'Release a slider to update the full projection');
}
function experienceCompare(){
  const ca=document.getElementById('chartArea');
  ca.insertAdjacentHTML('afterbegin',experienceHeader('DECISIONS / SCENARIOS','Understand the tradeoff.','Choose a case to compare with your current working assumptions. Then inspect the full matrix if needed.'));
  const children=[...ca.children],diff=children[1];
  if(diff){const label=[...diff.querySelectorAll('div')].find(n=>n.children.length===0&&n.textContent.includes('Diff view'));if(label)label.textContent='Current plan compared with';}
  const rest=children.slice(2);if(rest.length)experienceFold(ca,rest,'All cases & parameter differences','compare-full');
}
function experienceWhatIf(){
  const ca=document.getElementById('chartArea');
  ca.insertAdjacentHTML('afterbegin',experienceHeader('DECISIONS / WHAT-IF','See what a different choice changes.','Preview a decision, inspect the effect, and save a separate scenario when it fits.'));
  const stress=document.getElementById('wiStress'),levers=document.getElementById('wiKL'),head=levers?.previousElementSibling;
  if(stress)experienceFold(ca,[stress],'Stress the plan: markets, income & housing','decision-stress');
  if(levers)experienceFold(ca,[head,levers].filter(Boolean),'Which assumptions matter most? Sensitivity & simulations','decision-sensitivity');
}
function experienceAdvisor(){
  const ca=document.getElementById('chartArea');
  const h=ca.querySelector('h2');if(h)h.textContent='A second set of eyes.';
  const composer=ca.querySelector('.adv-composer');
  if(composer&&!_demoMode){
    const p=document.createElement('div');p.className='ex-advisor-prompts';
    p.innerHTML=[['Pressure points','Which years are most financially demanding? Separate cash shortfalls, equity sales and liquidity.'],['Housing tradeoffs','Explain what limits our home affordability and what assumptions most change the answer.'],['Check assumptions','Which assumptions in our plan deserve the most scrutiny? Name the evidence and uncertainty.']].map(([label,q])=>`<button onclick="experienceAdvisorPrompt('${q}')">${label} ↗</button>`).join('');
    composer.before(p);
  }
}
function experienceAdvisorPrompt(q){const el=document.getElementById('advInput');if(el){el.value=q;el.focus();}}
let walkthroughIndex=0;
const walkthroughSteps=[['Your position','Start with observed balances and modeled cash flow. Open the composition to inspect account coverage.','cockpit',null],['Your future','Scrub through the years. Family milestones and financial pressure points move together.','projection','life'],['Your spending','See your household plan beside imported actual spending. Open any category to inspect its rules.','today','budget'],['Your decisions','Explore a home purchase, monthly payments and rent versus buy. Preview assumptions before applying them.','home','housing'],['Your advisor','Ask a focused question with the current plan in view. Review proposed changes before accepting them.','advisor',null]];
function openGuidedWalkthrough(){walkthroughIndex=0;walkthroughShow();}
function walkthroughShow(){
  const [title,desc,tab,sub]=walkthroughSteps[walkthroughIndex];
  if(tab==='projection')_projView=sub;if(tab==='home')_homeView=sub;if(tab==='today')_todayView=sub;
  setTab(tab);window.scrollTo({top:0,behavior:'instant'});
  document.getElementById('exWalkthrough')?.remove();
  const el=document.createElement('aside');el.id='exWalkthrough';el.className='ex-walkthrough';el.setAttribute('aria-label','Guided walkthrough');
  el.innerHTML=`<span class="ex-kicker">WALKTHROUGH · ${walkthroughIndex+1} / ${walkthroughSteps.length}</span><button class="ex-walk-close" aria-label="Close walkthrough" onclick="document.getElementById('exWalkthrough').remove()">×</button><h3>${title}</h3><p>${desc}</p><div><button class="ui-btn" ${walkthroughIndex===0?'disabled':''} onclick="walkthroughIndex--;walkthroughShow()">Back</button><button class="ui-btn ui-btn-primary" onclick="${walkthroughIndex===walkthroughSteps.length-1?"document.getElementById('exWalkthrough').remove()":"walkthroughIndex++;walkthroughShow()"}">${walkthroughIndex===walkthroughSteps.length-1?'Finish':'Next →'}</button></div>`;
  document.body.append(el);
}
function experienceEnhance(){
  if(!_planLoaded)return;
  experienceNavigation();
  const R=run(P).R;
  if(activeTab==='cockpit')experienceOverview(R);
  if(activeTab==='today'&&_todayView==='budget')experienceBudget(R);
  if(activeTab==='today'&&_todayView==='spending')experienceSpending();
  if(activeTab==='home'&&['housing','rentbuy'].includes(_homeView))experienceHousing(R);
  if(activeTab==='home'&&_homeView==='compare')experienceCompare();
  if(activeTab==='home'&&_homeView==='explore')experienceWhatIf();
  if(activeTab==='advisor')experienceAdvisor();
  document.body.dataset.experience='cockpit';
}
const experienceOriginalRender=render;
render=function(){experienceOriginalRender();experienceEnhance();};
// Complete a focused comparison by default; original matrix remains accessible.
const experienceOriginalHome=renderHomeTab;
renderHomeTab=function(R,p){
  if(p.housingMode!=='rent')return experienceOriginalHome(R,p);
  destroyCharts();document.getElementById('chartArea').innerHTML='<div id="homeRB"></div><div id="homeHS"></div>';
  renderRentBuyTab(R,p,'homeRB');
  const buy={...rbParams(),housingMode:'buy'};renderHousingTab(run(buy).R,buy,'homeHS');
};
afParams=()=>({...rbParams(),housingMode:'buy'});
const experienceCompareRender=renderCompareTab;
renderCompareTab=function(R,p){if(_compareDiffIdx<0&&scenarios.length)_compareDiffIdx=Math.max(0,scenarios.findIndex((s,i)=>i!==activeScenarioIdx));experienceCompareRender(R,p);};
// Header captions used by the original chart modes.
SUB_VIEWS.projection.views.unshift(['life','spark','Life timeline']);
MORE_ACTIONS.unshift(['↗','Guided walkthrough','openGuidedWalkthrough()']);
if(_planLoaded)render();

function experienceMobileTools(){
 document.getElementById('exToolsOverlay')?.remove();const el=document.createElement('div');el.id='exToolsOverlay';el.className='ex-tools-overlay';el.innerHTML='<div class="ex-tools-sheet"><button class="ex-tools-close ui-btn" onclick="document.getElementById(\'exToolsOverlay\').remove()">Close ×</button><h3>Details & tools</h3>'+[['Accounts & holdings',"experienceUtility('today','overview')"],['Stripe equity',"experienceUtility('stripe')"],['Watchlist',"experienceUtility('today','watch')"],['Plan assumptions',"experienceUtility('inputs')"],['Guided walkthrough','openGuidedWalkthrough()'],['Present with demo numbers','enterDemoMode()'],['Export CSV','exportCSV()'],['Print / PDF','printPDF()']].map(([l,fn])=>'<button onclick="document.getElementById(\'exToolsOverlay\').remove();'+fn+'">'+l+' ↗</button>').join('')+'</div>';document.body.append(el);}

function experienceBudgetRanking(row,actual,mode){
 const values={...row.livFullParts,housing:row.hFull,childcare:row.ccFull,tuition:row.tuFull,...(row.eAdj?{oneoff:row.eAdj}:{})};
 return Object.entries(values).map(([key,v])=>({key,planned:v/12,actual:actual?.lines[key]?.perMonth??null})).filter(x=>x.planned!==0||(x.actual??0)>0).filter(x=>mode!=='over'||x.actual!=null&&x.actual>x.planned).sort((a,b)=>mode==='over'?(b.actual-b.planned)-(a.actual-a.planned):(b.actual??b.planned)-(a.actual??a.planned));
}
function experienceBudgetReveal(key){const el=key==='oneoff'?document.getElementById('bd-g-oneoff'):document.querySelector('.bd-row[data-line="'+key+'"]');if(!el)return;for(let parent=el.parentElement;parent;parent=parent.parentElement){if(parent.tagName==='DETAILS'){parent.open=true;if(parent.dataset.fold)experienceFolds.add(parent.dataset.fold);}}document.querySelectorAll('.ex-row-highlight').forEach(n=>n.classList.remove('ex-row-highlight'));el.classList.add('ex-row-highlight');el.scrollIntoView({behavior:_reduceMotion()?'instant':'smooth',block:'center'});const details=el.querySelector('.ex-row-detail');if(details?.hidden)el.querySelector('.ex-row-more')?.click();}

// Visual briefing: use the same values as the category table; never infer complete coverage.
const visualPalette=['#365d45','#688363','#8d9e78','#b2b89b','#a68b66','#bdc7ae'];
function experienceDonut(entries,total,label,note){
  const positive=entries.filter(x=>Number(x.value)>0).sort((a,b)=>b.value-a.value);
  const top=positive.slice(0,5),rest=positive.slice(5).reduce((a,x)=>a+x.value,0);
  if(rest>0)top.push({label:'Other categories',value:rest});
  const scale=top.reduce((a,x)=>a+x.value,0),circ=2*Math.PI*86;let offset=0;
  const arcs=top.map((x,i)=>{const share=scale?x.value/scale:0,len=Math.max(0,share*circ-4),arc=`<circle cx="110" cy="110" r="86" fill="none" stroke="${visualPalette[i]}" stroke-width="13" stroke-dasharray="${len} ${circ-len}" stroke-dashoffset="${-offset}" transform="rotate(-90 110 110)"><title>${experienceEscape(x.label)} · ${experienceMoney(x.value)} · ${(share*100).toFixed(1)}%</title></circle>`;offset+=share*circ;return arc;}).join('');
  return `<div class="ex-composition"><div class="ex-donut"><svg viewBox="0 0 220 220" role="img" aria-label="${experienceEscape(label)} by category"><circle cx="110" cy="110" r="86" fill="none" stroke="#d8ddcd" stroke-width="13"/>${arcs}</svg><div><span>${label}</span><strong>${experienceMoney(total)}</strong><small>${note}</small></div></div><div class="ex-composition-key">${top.map((x,i)=>`<div><i style="background:${visualPalette[i]}"></i><span>${experienceEscape(x.label)}</span><strong>${experienceMoney(x.value)}</strong><small>${scale?(x.value/scale*100).toFixed(0):0}%</small></div>`).join('')}</div></div>`;
}
function experienceSignal(icon,kicker,title,body,tone='neutral'){
  return `<article class="ex-signal" data-tone="${tone}"><span class="ex-signal-icon">${UI.icon(icon)}</span><div><span class="ex-kicker">${kicker}</span><h3>${title}</h3><p>${body}</p></div></article>`;
}
function experienceBudgetVisual(R){
 const bd=document.querySelector('.bd');if(!bd)return;
 const yr=Math.min(R.at(-1).yr,Math.max(R[0].yr,_budgetYear??PlannerTime.year())),r=R.find(x=>x.yr===yr),mo=_budgetUnit==='month';
 const act=yr===PlannerTime.year()?PlannerBudget.actuals(_spend,yr,P.monarchLineMap):null;
 const plan=r.totEFull/12,diff=act?act.perMonth-plan:null,ratio=act&&plan>0?act.perMonth/plan:null;
 const driver=experienceBudgetRanking(r,act,'over')[0];
 const displayed=v=>experienceMoney(v*(mo?1:12)),unit=mo?'/mo':'/yr';
 const tone=diff!=null&&diff>Math.max(100,plan*.05)?'warn':'neutral';
 const hero=document.createElement('section');hero.className='ex-briefing ex-budget-briefing';hero.dataset.tone=tone;hero.dataset.state=act?(diff>0?'over':'under'):'plan';
 const headline=act?Math.abs(diff)<100?'Your spending pace is close to plan.':`Spending pace is ${displayed(Math.abs(diff))}${unit} ${diff>0?'above':'below'} plan.`:`Your ${yr} household spending plan.`;
 const future=yr>PlannerTime.year();
 const summary=future?`For ${PlannerSuggest.household(P,yr)} · includes modeled inflation and family costs. Review the year’s assumptions and upcoming costs below.`:act?`${act.months} past months with records · actual monthly average compared with the full-year plan. Import gaps can affect this comparison.`:'No comparable closed-month actuals are available for this year. Explore the planned categories below.';
 hero.innerHTML=`<div class="ex-briefing-copy"><span class="ex-kicker">YOUR BUDGET / THE READOUT</span><h2>${headline}</h2><p>${summary}</p>${future?'':`<div class="ex-budget-meter"><div><span>Planned ${displayed(plan)}${unit}</span><strong>${ratio==null?'Actuals unavailable':(ratio*100).toFixed(0)+'% of planned pace'}</strong></div><div class="ex-budget-meter-track"><i style="width:${ratio==null?0:Math.min(100,ratio/1.3*100)}%"></i><b style="left:${100/1.3}%" title="100% of plan"></b></div><small>Budget marker = 100% · scale ends at 130%${ratio>1.3?' (actual is above the scale)':''}</small></div>`}</div><div class="ex-briefing-stat"><span>${act?'Actual spending pace':'Planned household spending'}</span><strong>${displayed(act?act.perMonth:plan)}</strong><small>${mo?'Per month':act?'Annualized / year':'Per year'} · household total</small></div>`;
 const anchor=bd.querySelector('.bd-bar');anchor.after(hero);
 const allocationBand=bd.querySelector('.ex-budget-answer');if(allocationBand)experienceFold(bd,[allocationBand],'Planned cash investing & retained equity','budget-invest-summary');
 if(driver){const note=document.createElement('button');note.className='so-budget-note';note.innerHTML=`<span>${experienceEscape(LIV_LABEL[driver.key]||driver.key)} is the largest overage: <strong>${displayed(driver.actual-driver.planned)}${unit}</strong> above plan.</span><span>Inspect the line ↗</span>`;note.onclick=()=>experienceBudgetReveal(driver.key);hero.after(note);}
 const stage=document.createElement('section');stage.className='so-budget-stage';hero.before(stage);stage.append(hero);const note=bd.querySelector('.so-budget-note');if(note)stage.append(note);const rank=bd.querySelector('.ex-budget-chart');if(rank)stage.append(rank);
 const lines=bd.querySelector('.bd-lines');if(lines)experienceFold(bd,[lines],'Open full budget & edit categories','budget-editor');
 const support=[...bd.children].filter(n=>n.tagName==='DETAILS'&&n.dataset.fold!=='budget-editor');
 if(support.length)experienceFold(bd,support,'Model details, allocation & data','budget-all-details');
 if(act?.unmappedTotal){const warning=document.createElement('button');warning.className='so-mapping-note';warning.textContent=experienceMoney(act.unmappedTotal/act.months)+'/mo of recorded spending has no matched budget category. Review mapping ↗';warning.onclick=()=>experienceRevealElement(bd.querySelector('.bd-map'));stage.after(warning);}
 experiencePlanReview(bd,r,yr,R);

}
function experienceSpendingVisual(){
 const w=document.querySelector('.spending-workspace');if(!w||!_spend||_spend.error)return;
 const rows=window.__spendingViz?.rows||[];if(!rows.length)return;
 const allMonths=_spend.months||[],asOf=_spend.endDate,closed=allMonths.filter(m=>m.month<String(asOf).slice(0,7));
 const period=spendScopeLabel(closed,asOf,allMonths);
 const section=document.createElement('section');section.className='ex-spending-visual';
 const partial=_spendScope.kind==='month'&&_spendScope.month===String(_spend.endDate).slice(0,7);
 const sum=rows.reduce((a,x)=>a+x.perMonth,0),max=Math.max(1,...rows.map(x=>x.perMonth));
 section.innerHTML=`<section class="so-spend-chart"><div class="ex-panel-head"><div><span class="ex-kicker">WHERE THE MONEY GOES</span><h3>${experienceMoney(sum)}<small> ${partial?'so far':'average / month'}</small></h3><p>${experienceEscape(period)} · net of refunds${!partial&&allMonths.some(m=>m.month===String(asOf).slice(0,7))&&['ytd','all'].includes(_spendScope.kind)?' · current month included as recorded, not extrapolated':''}</p></div><div class="ex-segments">${[['ytd',null,'YTD'],...[3,6,12].filter(n=>closed.length>=n).map(n=>['recent',n,n+'M']),['all',null,'All']].map(([kind,n,label])=>`<button aria-pressed="${_spendScope.kind===kind&&(kind!=='recent'||Number(_spendScope.months)===n)}" onclick="setSpendScope('${kind}',${n})">${label}</button>`).join('')}</div></div><div class="so-spend-bars">${rows.slice(0,8).map((x,i)=>`<div class="so-spend-row"><span>${experienceEscape(x.name)}</span><div><i style="width:${Math.max(0,x.perMonth)/max*100}%;opacity:${1-i*.065}"></i></div><strong>${experienceMoney(x.perMonth)}</strong><small>${sum>0?(x.perMonth/sum*100).toFixed(0)+'%':'—'}</small></div>`).join('')}</div><p class="ex-chart-caption">${rows.length>8?'Largest 8 of '+rows.length+' categories · ':''}Import coverage can affect these amounts. Negative values are net refunds.</p><details class="ex-detail"><summary>Category composition</summary>${experienceDonut(rows.map(x=>({label:x.name,value:x.perMonth})),sum,'Recorded spending',partial?'month to date':'per month')}<p class="ex-chart-caption">The ring shows positive net categories; refund-only categories remain in the full table.</p></details></section>`;
 const averages=w.querySelector('.ex-spend-averages');if(averages)experienceFold(w,[averages],'Compare 3-, 6- and 12-month averages','spending-averages');

 const lens=[...w.children].find(n=>n.textContent.includes('Categories against your income'));
 if(lens)experienceFold(w,[lens],'All categories, exact amounts & income comparison','spending-category-detail');
 const drift=w.querySelector('#spendLtmChart')?.closest('section'),pace=w.querySelector('.pace');
 const stage=document.createElement('section');stage.className='so-spending-stage';
 stage.innerHTML=`<div class="so-question-tabs" aria-label="Spending question">${[['categories','Where it goes'],['trend','How it’s changing'],['month','This month']].map(([v,label])=>`<button aria-pressed="${spendingStoryView===v}" onclick="spendingStoryView='${v}';render()">${label}</button>`).join('')}</div>`;
 w.querySelector('.ex-heading').after(stage);stage.append(section);section.hidden=spendingStoryView!=='categories';
 if(drift){stage.append(drift);drift.hidden=spendingStoryView!=='trend';drift.querySelector('h3').textContent='Is our spending rising?';}
 if(pace){stage.append(pace);pace.hidden=spendingStoryView!=='month';}
 const supporting=[...w.children].filter(n=>n!==stage&&!n.classList.contains('ex-heading'));
 if(supporting.length){const detail=experienceFold(w,supporting,'Transactions, comparisons & data sources','spending-details');detail.addEventListener('toggle',()=>{if(detail.open)charts.spendingMonths?.resize?.();});}
 if(spendingStoryView==='trend'&&charts.spendingLtm){const ch=charts.spendingLtm;for(const axis of Object.values(ch.options.scales||{})){if(axis.ticks)axis.ticks.color='#52666c';if(axis.grid)axis.grid.color='#d6dfdf';}if(ch.options.plugins?.legend?.labels)ch.options.plugins.legend.labels.color='#334b53';ch.resize?.();ch.update('none');}
 const coverage=document.createElement('p');coverage.className='so-source-note';
 const verified=_spend.coverage?.completeMonths?.length||0;
 coverage.textContent=`Monarch · ${closed.length} past months with records · ${verified} verified full months${_spend.state?.lastError?' · an import error needs review':''}.`;
 stage.after(coverage);

}
const experienceVisualEnhance=experienceEnhance;
experienceEnhance=function(){experienceVisualEnhance();const R=run(P).R;if(activeTab==='today'&&_todayView==='budget')experienceBudgetVisual(R);if(activeTab==='today'&&_todayView==='spending')experienceSpendingVisual();experienceChartFormatting();};

// Every comparison carries its scale, source and exact values, including missing actuals.
function experienceRankChart(row,actual,monthly){
  const future=row.yr>PlannerTime.year(),checks=future?experienceFutureChecks(P,row):[],byLine=new Map(checks.map(c=>[c.line,c]));
  const all=experienceBudgetRanking(row,actual,future?'size':budgetRankMode).filter(x=>!future||budgetRankMode!=='over'||byLine.has(x.key)),rows=budgetShowAll?all:all.slice(0,8);
  const max=Math.max(1,...rows.flatMap(x=>[x.planned,x.actual??0]));
  const factor=monthly?1:12,unit=monthly?'per month':actual?'annualized pace':'per year';
  const exact=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(v*factor);
  const head=`<div class="ex-panel-head"><div><span class="ex-kicker">CATEGORY COMPARISON</span><h3>${budgetRankMode==='over'?(future?'Assumptions worth reviewing':'What’s over budget?'):'The biggest spending categories.'}</h3><p>${actual?'Recorded pace and your plan':'Planned amounts'} · ${monthly?'per month':future?'per year':unit}${all.length>8&&!budgetShowAll?' · top 8 of '+all.length:''}</p></div><div class="ex-segments"><button aria-pressed="${budgetRankMode==='size'}" onclick="budgetRankMode='size';render()">By size</button><button aria-pressed="${budgetRankMode==='over'}" onclick="budgetRankMode='over';render()">${future?'Needs review':'Over budget'}</button></div></div>`;
  const legend=`<div class="ex-rank-key">${actual?'<span><i class="actual"></i>At / under plan</span><span><i class="over"></i>Over plan</span><span><i class="marker"></i>Budget</span>':''}<span><i class="planned"></i>Plan only</span></div>`;
  const bars=rows.map(x=>{
    const name=x.key==='oneoff'?'One-off costs & adjustments':LIV_LABEL[x.key]||x.key,hasActual=x.actual!=null,value=x.actual??x.planned,delta=hasActual?x.actual-x.planned:null;
    const over=hasActual&&delta>0;
    const guide=byLine.get(x.key);
    const detail=hasActual?Math.abs(delta)<1?'Matches plan':`${experienceMoney(Math.abs(delta)*factor)} ${over?'over':'under'} plan`:future&&guide?`${guide.status==='low'?'Below':'Above'} household guide · review`:actual?'No matched actuals':'Planned amount';
    const accessible=`${name}: ${hasActual?'actual pace':'planned'} ${exact(value)}, budget ${exact(x.planned)}, ${unit}. ${detail}. Open budget line.`;
    return `<button class="ex-rank-row" data-kind="${hasActual?'actual':'planned'}" data-over="${over}" data-review="${!!guide}" aria-label="${experienceEscape(accessible)}" title="${experienceEscape(accessible)}" onclick="experienceBudgetReveal('${x.key}')"><span class="ex-rank-label">${experienceEscape(name)}</span><strong>${experienceMoney(value*factor)}</strong><span class="ex-rank-track"><i style="width:${Math.max(0,value)/max*100}%"></i>${hasActual?`<b style="left:${Math.max(0,x.planned)/max*100}%"></b>`:''}</span><small class="ex-rank-delta ${over?'warn':''}">${detail}</small></button>`;
  }).join('');
  return head+(rows.length?legend+bars:`<div class="ex-chart-empty">${future?'No category falls outside the household guide.':actual?'No mapped category is above plan.':'Actual spending is unavailable for this year.'}<span>${future?'This is a broad modeling guide, not a complete assessment. Review upcoming costs below.':actual?'Check unmapped spending before drawing a conclusion.':'Use By size to explore the planned categories.'}</span></div>`)+(all.length>8?`<button class="so-show-all" onclick="budgetShowAll=!budgetShowAll;render()">${budgetShowAll?'Show main categories':'Show all '+all.length+' categories'} ↗</button>`:'')+`<p class="ex-chart-caption">Shared dollar scale · select a category to inspect it${actual?' · imported coverage can affect actual pace':''}.</p>`;
}
function experienceCashBridge(row,year){
  const income=deflate(row.incFull/12,year),spend=deflate(row.totEFull/12,year),delta=income-spend,max=Math.max(1,income,spend);
  const money=v=>experienceMoney(v);
  const bar=(label,v,kind)=>`<div class="ex-cash-row"><span>${label}</span><strong>${money(v)}</strong><div><i data-kind="${kind}" style="width:${Math.max(0,v)/max*100}%"></i></div></div>`;
  return `<div class="ex-cash-title"><span class="ex-kicker">MONTHLY CASH FLOW · ${year}</span><span>${inflationView?'Today’s dollars ('+P.planStartYear+')':'Future dollars'}</span></div><div class="ex-cash-comparison">${bar('Cash pay after tax',income,'income')}${bar('Household spending',spend,'spend')}<div class="ex-cash-result" data-shortfall="${delta<0}"><span>${delta<0?'To fund from assets':'Cash remaining'}</span><strong>${money(Math.abs(delta))}<small>/mo</small></strong><p>${delta<0?'Spending exceeds cash pay.':'Before additional saving or investing.'}</p></div></div><p class="ex-chart-caption">Same scale · cash pay excludes unsold equity · home-purchase funds are separate.</p>`;
}

function experienceBudgetGuide(plan,row,key){
  const band=PlannerSuggest.BANDS[key];if(!band)return null;
  const factor=Math.pow(1+(Number(plan.expenseInflation)||0),Math.max(0,row.yr-(plan.planStartYear||row.yr)));
  const people=PlannerSuggest.people(plan,row.yr),lo=band.per[0]*people*factor,hi=band.per[1]*people*factor;
  const value=row.livFullParts?.[key];if(!Number.isFinite(value))return null;
  const status=value<lo-.5?'low':value>hi+.5?'high':'within';
  // Round inside the band, not above its upper limit or below its lower limit.
  const monthly=status==='high'?Math.floor(hi/12):status==='low'?Math.ceil(lo/12):Math.round(value/12);
  return {lo,hi,value,status,annual:monthly*12,year:row.yr};
}
function experienceBudgetGuideHtml(plan,row,key){
  const g=experienceBudgetGuide(plan,row,key);if(!g)return '';
  const flagged=g.status!=='within',name=experienceEscape(LIV_LABEL[key]||key);
  return `<section class="ex-guide-recommendation"><span class="ex-kicker">${flagged?'ASSUMPTION TO REVIEW':'WITHIN HOUSEHOLD GUIDE'}</span><strong>${name}: ${experienceMoney(g.lo/12)}–${experienceMoney(g.hi/12)}/mo</strong><p>${row.yr} dollars · ${experienceEscape(PlannerSuggest.household(plan,row.yr))} · broad planning range, not measured NYC spending.</p>${flagged?`<p>Your plan is ${experienceMoney(g.value/12)}/mo. ${g.status==='high'?'Consider reducing':'Consider allowing'} it to <strong>${experienceMoney(g.annual/12)}/mo</strong> to bring it within the guide.</p><button class="ui-btn ui-btn-primary" onclick="experienceApplyBudgetGuide('${key}',${row.yr})">Use ${experienceMoney(g.annual/12)}/mo for ${row.yr}</button><small>Changes this year only, across shared cases. Undo is available.</small>`:''}</section>`;
}
function experienceApplyBudgetGuide(key,year){
  const row=run(P).R.find(r=>r.yr===year);if(!row)return;
  const g=experienceBudgetGuide(P,row,key);if(!g||g.status==='within')return;
  const edit=PlannerBudget.edit(P,{category:key,year,scope:'year',input:{kind:'amount',annual:g.annual},basis:'net',income:{net:row.netTC,gross:row.gross}});
  if(!edit.ok){showToast(edit.error,'red');return;}
  budgetApply(edit,`${LIV_LABEL[key]||key} → ${experienceMoney(g.annual/12)}/mo, ${year} only`);
  experienceBudgetReveal(key);
}
function experienceFutureChecks(plan,row){
  // Compare future spending in base-year purchasing power, so inflation alone is not a warning.
  const factor=Math.pow(1+(Number(plan.expenseInflation)||0),Math.max(0,row.yr-(plan.planStartYear||row.yr)));
  const base={...row,livFullParts:Object.fromEntries(Object.entries(row.livFullParts||{}).map(([k,v])=>[k,v/factor]))};
  return PlannerSuggest.checks(plan,[base],row.yr).filter(c=>experienceBudgetGuide(plan,row,c.line)?.status!=='within');
}
function experienceOpenBudgetSuggestion(){
  document.querySelectorAll('.so-nudge').forEach(n=>n.open=true);
  const el=document.querySelector('.bd-assume');if(!el)return;
  for(let n=el;n;n=n.parentElement)if(n.tagName==='DETAILS'){n.open=true;if(n.dataset.fold)experienceFolds.add(n.dataset.fold);}
  el.scrollIntoView({behavior:_reduceMotion()?'instant':'smooth',block:'center'});
}
function experiencePlanReview(bd,row,year,R){
  const future=year>PlannerTime.year(),pending=experiencePendingSuggestions(P,year),checks=future?experienceFutureChecks(P,row):[];
  const source=bd.querySelector('.bd-assume');if(!source)return;
  // Replace nominal-dollar heuristic text in future years with a base-dollar comparison.
  if(future){
    const old=source.querySelector('.bd-checks');if(old)old.remove();
    const guide=document.createElement('div');guide.className='so-guide-detail';
    guide.innerHTML='<p>Household guides use '+P.planStartYear+' purchasing power and broad modeling assumptions. They are not measured spending by comparable NYC households.</p>'+checks.map(c=>`<button onclick="experienceBudgetReveal('${c.line}')"><strong>${experienceEscape(LIV_LABEL[c.line]||c.line)} · ${c.status==='low'?'below':'above'} guide</strong><span>${experienceMoney(c.value/12)}/mo in base-year dollars; guide ${experienceMoney(c.lo/12)}–${experienceMoney(c.hi/12)}/mo. Inspect your assumption ↗</span></button>`).join('');
    source.append(guide);
  }
  if(!pending.length&&!checks.length)return;
  const panel=document.createElement('section');panel.className='so-plan-review';
  panel.innerHTML=`<div class="so-review-head"><div><span class="ex-kicker">${future?'PLAN AHEAD':'UPCOMING COSTS'}</span><h3>Worth planning for.</h3><p>${year}–${year+2} · suggestions to review, not expenses already included.</p></div><button onclick="experienceOpenBudgetSuggestion()">All suggestions ↗</button></div>`;
  const nodes=[...source.querySelectorAll('.bd-sug')];
  for(const [i,node]of nodes.slice(0,2).entries()){
    const e=pending[i];if(!e)continue;
    const d=document.createElement('details');d.className='so-nudge';
    const summary=document.createElement('summary');summary.textContent=e.year+' · '+(e.item?.label||e.title);d.append(summary,node);panel.append(d);
  }
  if(checks.length){const c=checks[0],b=document.createElement('button');b.className='so-review-check';b.innerHTML=`<span>${experienceEscape(LIV_LABEL[c.line]||c.line)} is ${c.status==='low'?'below':'above'} the household guide.<small>Compared in ${P.planStartYear} dollars · ${checks.length} assumption${checks.length===1?'':'s'} to review</small></span><span>Inspect ↗</span>`;b.onclick=()=>experienceBudgetReveal(c.line);panel.append(b);}
  bd.querySelector('.so-budget-stage').after(panel);
}

function experienceRevealElement(el){
  if(!el)return;
  for(let n=el;n;n=n.parentElement)if(n.tagName==='DETAILS'){n.open=true;if(n.dataset.fold)experienceFolds.add(n.dataset.fold);}
  el.scrollIntoView({behavior:_reduceMotion()?'instant':'smooth',block:'center'});
}

function experiencePendingSuggestions(plan,year){
  const start=Math.min(year,plan.planStartYear||year);
  return PlannerSuggest.pending(plan,start,Math.max(2,year+2-start)).filter(e=>e.year>=year&&e.year<=year+2||e.perYear&&e.item.from<year&&e.item.to>=year).map(e=>e.year<year?{...e,year,title:e.title+' · ongoing'}:e);
}

function experienceChartFormatting(){
  if(typeof Chart!=='undefined'&&Chart.defaults)Chart.defaults.color='#64705d';
  for(const chart of Object.values(charts)){
    if(!chart?.options)continue;
    for(const axis of Object.values(chart.options.scales||{})){
      if(axis.ticks)axis.ticks.color='#65705f';
      if(axis.grid)axis.grid.color='rgba(38,65,40,.09)';
      if(axis.title)axis.title.color='#53634c';
    }
    if(chart.options.plugins?.legend?.labels)chart.options.plugins.legend.labels.color='#53634c';
    chart.update?.('none');
  }
}
