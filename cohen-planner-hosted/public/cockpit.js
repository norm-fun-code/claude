/* Presentation only: reads the existing account cache and shared projection engine. */
let cockpitYear=null;
function cockpitGo(view){
  if(['overview','watch','spending','holdings'].includes(view)){_todayView=view;setTab('today');}
  else setTab(view);
}
function cockpitQuestion(question){
  setTab('advisor');
  const input=document.getElementById('advInput');
  if(input){input.value=question;input.focus();}
}
function cockpitRefresh(){_ovw=null;loadOverview();loadInbox(true);render();}
function renderCockpit(R){
  destroyCharts();
  if(_ovw===null&&!_ovwLoading)loadOverview();
  if(!_inbox&&!_inboxLoading&&!_inboxError)loadInbox();
  const e=advEscape,d=_ovw,s=d?.summary;
  const available=!!s&&!d.error&&d.capabilities?.balances?.available===true;
  const partial=available&&(s.complete!==true||d.partial===true||monarchSnapshot?.partial===true);
  const date=d?.asOf?new Date(d.asOf):null;
  const dated=date&&Number.isFinite(date.getTime());
  const stale=dated&&Date.now()-date.getTime()>7*86400000;
  const status=!d?'Reading accounts':!available?'Accounts unavailable':partial?'Partial balances':!dated?'Balance date unavailable':stale?'Refresh recommended':'Latest reported balances';
  const money=v=>Number.isFinite(v)?fmt(v):'—';
  const current=R.find(r=>r.yr===new Date().getFullYear())||R[0];
  const end=R[R.length-1],floor=R.reduce((a,b)=>a.liq<b.liq?a:b);
  const selected=R.find(r=>r.yr===cockpitYear)||current;cockpitYear=selected.yr;
  const metric=(title,value,detail,action)=>`<button class="cp-metric" onclick="cockpitGo('${action}')"><span>${title}</span><strong>${value}</strong><small>${detail}</small></button>`;
  const priorities=(_inbox?.priorities||[]).slice(0,3);
  document.getElementById('summaries').innerHTML='';
  document.getElementById('chartArea').innerHTML=`<div class="cockpit">
    <header class="cp-heading"><div><div class="cp-eyebrow">YOUR PRIVATE OFFICE</div><h2>Financial command.</h2></div><button class="cp-button" onclick="cockpitRefresh()" ${_ovwLoading||_inboxLoading?'disabled':''}>Refresh overview ↻</button></header>
    <div class="cp-source" role="status"><span class="${partial||stale||!available?'cp-amber':''}">${e(status)}</span>${dated?`<span>As of ${e(date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}))}</span>`:''}<button onclick="cockpitGo('overview')">Sources & accounts ↗</button></div>
    <section class="cp-position" aria-label="Financial position">
      <div class="cp-wealth"><span class="cp-eyebrow">${partial?'KNOWN NET WORTH':'REPORTED NET WORTH'}</span><strong>${available?money(s.netWorth):'—'}</strong><p>${available?`${money(s.assets)} assets · ${money(s.debt)} liabilities`:'Your plan is available while accounts load or reconnect.'}</p><button onclick="cockpitGo('overview')">See the composition <span>↗</span></button></div>
      <div class="cp-metrics">${metric('Cash + taxable investments',available?money(s.accessible):'—','Gross assets · before liabilities & sale taxes','overview')}${metric('Retirement',available?money(s.byClass?.retirement?.total):'—','Separate from accessible investments','holdings')}${metric('Vested Stripe',available?money(s.stripeVested):'—','Private equity · sale windows apply','stripe')}${metric(`${current.yr} planned monthly margin`,money(current.flow/12),'Projection · annual net flow ÷ 12','cashflow')}</div>
    </section>
    <div class="cp-workspace"><div class="cp-main-column">
      <section class="cp-card cp-trajectory"><div class="cp-section-head"><div><span class="cp-eyebrow">CURRENT PLAN / PROJECTION</span><h3>The path ahead</h3></div><button onclick="cockpitGo('home')">Explore a what-if ↗</button></div>
      <div class="cp-chart-summary"><div><span id="cp-year">${selected.yr} year-end wealth</span><strong id="cp-value">${money(selected.nw+selected.k401)}</strong></div><span>Includes retirement<br>Future dollars · assumed returns</span></div>
      <div class="cp-chart"><canvas id="cockpitTrajectory" aria-label="Projected wealth and liquid investments by year" role="img"></canvas></div>
      <label class="cp-scrub" for="cp-year-range">Explore a year<input id="cp-year-range" type="range" min="${R[0].yr}" max="${end.yr}" value="${selected.yr}" oninput="cockpitSelectYear(Number(this.value))"><output id="cp-range-label">${selected.yr}</output></label>
      <div class="cp-year-grid" id="cp-year-grid"></div>
      <details class="cp-evidence"><summary>Show me why</summary><p>These are year-end estimates from your saved plan assumptions. Wealth includes modeled liquid investments, Stripe, home equity and retirement. The account balances above are separate observations; this chart is not a historical performance record.</p><button onclick="cockpitGo('table')">Inspect the yearly calculations ↗</button></details></section>
      <section class="cp-card"><div class="cp-section-head"><div><span class="cp-eyebrow">DECISION WORKSPACE</span><h3>What are you considering?</h3></div></div><div class="cp-decisions">
      <button onclick="cockpitGo('housing')"><span>01 / HOME</span><strong>Find your buying range</strong><small>Timing, down payment & funding →</small></button>
      <button onclick="cockpitGo('spending')"><span>02 / EVERYDAY LIFE</span><strong>Understand your spending</strong><small>Transactions, categories & history →</small></button>
      <button onclick="cockpitGo('holdings')"><span>03 / INVESTMENTS</span><strong>See your exposure</strong><small>Positions, allocation & concentration →</small></button></div></section>
    </div><aside class="cp-advisor">
      <section class="cp-card cp-attention"><div class="cp-section-head"><div><span class="cp-eyebrow">SIGNALS / REVIEW</span><h3>Your attention</h3></div><span class="cp-count">${priorities.length||'—'}</span></div>
      ${_inboxError?'<p>Checks could not load. Open the watchlist to retry.</p>':!_inbox?'<p role="status">Reading your watchlist…</p>':priorities.length?priorities.map((a,i)=>`<button class="cp-signal" onclick="cockpitGo('watch')"><span>0${i+1}</span><div><strong>${e(a.title||a.kind||'Review this signal')}</strong><small>Review evidence & assumptions ↗</small></div></button>`).join(''):'<p>No priorities returned by the checks that ran.</p>'}
      ${_inbox?`<p class="cp-meta">${Number(_inbox.checksRun)||0} of ${Number(_inbox.checksTotal)||0} checks ran. Signals depend on source coverage and model assumptions.</p>`:''}<button class="cp-text-link" onclick="cockpitGo('watch')">Open full watchlist →</button></section>
      <section class="cp-card cp-intelligence"><span class="cp-eyebrow">ADVISOR</span><h3>Think it through.</h3><p>Bring a question. Explore the trade-offs with your plan in view.</p>
      <button onclick="cockpitQuestion('What are the three most consequential decisions in my current plan? Show the evidence, source dates, uncertainty and what would change your recommendation.')">What deserves my attention? ↗</button>
      <button onclick="cockpitQuestion('How does a home purchase change my liquidity and long-term wealth? Identify missing closing costs, funding constraints and assumptions before recommending a range.')">Can we comfortably buy a home? ↗</button>
      <button onclick="cockpitQuestion('Review my portfolio concentration using the data you can actually access. Distinguish observed holdings from assumptions and identify any missing coverage.')">Where am I overexposed? ↗</button>
      <form onsubmit="event.preventDefault();cockpitQuestion(this.elements.question.value)"><label for="cp-question">Your question</label><textarea id="cp-question" name="question" required placeholder="What if I changed jobs…" rows="2"></textarea><button class="cp-button" type="submit">Prepare in advisor →</button></form><small>You review the question before sending.</small></section>
      <div class="cp-floor"><span>Lowest projected liquid investments</span><strong>${money(floor.liq)} <small>in ${floor.yr}</small></strong><button onclick="cockpitGo('home')">Explore the pressure point →</button></div>
    </aside></div></div>`;
  charts.cockpit=new Chart(document.getElementById('cockpitTrajectory'),{type:'line',data:{labels:R.map(r=>r.yr),datasets:[{label:'Total wealth incl. retirement · projected',data:R.map(r=>r.nw+r.k401),borderColor:'#7ae3c3',backgroundColor:'rgba(122,227,195,.08)',fill:true,pointRadius:0,pointHoverRadius:5,borderWidth:2,tension:.25},{label:'Liquid investments · projected',data:R.map(r=>r.liq),borderColor:'#a9a0ff',borderDash:[4,4],pointRadius:0,borderWidth:2,tension:.25}]},options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom',labels:{color:'#acb9cc',boxWidth:16,font:{size:12}}},tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${money(c.raw)}`}}},scales:{x:{grid:{display:false},ticks:{color:'#899ab1',maxTicksLimit:6}},y:{grid:{color:'rgba(167,190,221,.08)'},ticks:{color:'#899ab1',callback:v=>money(v)}}}}});
  cockpitSelectYear(selected.yr);
}
function cockpitSelectYear(year){
  cockpitYear=year;
  const row=run(P).R.find(r=>r.yr===year);if(!row)return;
  document.getElementById('cp-year').textContent=year+' year-end wealth';
  document.getElementById('cp-value').textContent=fmt(row.nw+row.k401);
  document.getElementById('cp-range-label').textContent=year;
  document.getElementById('cp-year-grid').innerHTML=[['Liquid investments',row.liq],['Vested Stripe',row.sEnd],['Home equity',row.eq]].map(([label,value])=>`<div><span>${label}</span><strong>${fmt(value)}</strong></div>`).join('');
}
