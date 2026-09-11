/* Presentation only: reads the existing account cache and shared projection engine. */
let cockpitYear=null;
// Retirement is wealth you cannot reach for decades. Some questions are about everything you
// own; others are about what is actually available before 59½, and a 401(k) that dwarfs the
// rest drowns those out. `cockpitExRet` toggles the whole cockpit between the two — hero,
// chart, band, headline and the reconciliation beneath it all move together, because a page
// showing one figure ex-retirement and another including it is the exact defect this cockpit
// spent a long time getting rid of.
//
// It is declared in index.html alongside the other persisted view state, not here:
// savePlannerState() writes it, and a save that reaches for a variable owned by a different
// file breaks the moment that file is not loaded.
// The one place the choice is applied. Everything on the cockpit reads net worth through
// here so a new surface cannot quietly pick the wrong field.
function cpNw(r){return r?(cockpitExRet?r.nw:r.netWorth):0}
function cpLabel(){return cockpitExRet?'net worth ex-retirement':'net worth'}
function cockpitSetExRet(ex){
  if(cockpitExRet===!!ex)return;
  cockpitExRet=!!ex;
  // No re-simulation: both bases come out of the same trials, so switching picks the other
  // one rather than running 250 more paths that would also disagree with the first set.
  render();savePlannerState();
}
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
  // Completeness is a fact about THE READING THE HERO IS SHOWING, so it is judged on _ovw
  // alone. It also consulted monarchSnapshot, which is a different sync down a different
  // code path, persisted with the plan — so one old partial sync marked every later reading
  // incomplete forever, with no account to point at and no way to clear it. A stale flag
  // from a source that contributes nothing to the number cannot say the number is short.
  const partial=available&&(s.complete!==true||d.partial===true);
  const date=d?.asOf?new Date(d.asOf):null;
  const dated=date&&Number.isFinite(date.getTime());
  const stale=dated&&Date.now()-date.getTime()>7*86400000;
  const status=!d?'Reading accounts':!available?'Accounts unavailable':partial?'Partial balances':!dated?'Balance date unavailable':stale?'Refresh recommended':'Latest reported balances';
  const money=v=>Number.isFinite(v)?fmt(v):'—';
  // The observed side has to be excluded the same way the projected side is, or the toggle
  // would silently compare a figure without retirement against one with it.
  const obsRetirement=Number(s&&s.byClass&&s.byClass.retirement?s.byClass.retirement.total:0)||0;
  const obsNw=available?(cockpitExRet?s.netWorth-obsRetirement:s.netWorth):null;
  const current=R.find(r=>r.yr===new Date().getFullYear())||R[0];
  const end=R[R.length-1],floor=R.reduce((a,b)=>a.liq<b.liq?a:b);
  const selected=R.find(r=>r.yr===cockpitYear)||current;cockpitYear=selected.yr;
  const metric=(title,value,detail,action)=>`<button class="cp-metric" onclick="cockpitGo('${action}')"><span>${title}</span><strong>${value}</strong><small>${detail}</small></button>`;
  // The hero must never render a dash. When accounts are unreachable the PLAN still
  // knows a net worth, so show that and let the provenance chip carry the doubt.
  const hero=UI.heroValue({
    observed:obsNw,
    projected:current?deflate(cpNw(current),current.yr):null,
    complete:available?!partial:undefined,
  });
  const priorities=(_inbox?.priorities||[]).slice(0,3);
  document.getElementById('summaries').innerHTML='';
  document.getElementById('chartArea').innerHTML=`<div class="cockpit">
    <header class="cp-heading"><div><h2>Financial command.</h2></div><button class="cp-button" onclick="cockpitRefresh()" ${_ovwLoading||_inboxLoading?'disabled':''}>Refresh overview ↻</button></header>
    <section class="cp-register" data-tense="now">
      <div class="cp-register-head">
        <span class="ui-eyebrow">Where you stand</span>
        <div class="cp-source" role="status"><span class="${partial||stale||!available?'cp-amber':''}">${e(status)}</span>${dated?`<span>As of ${e(date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}))}</span>`:''}<button onclick="cockpitGo('overview')">Sources & accounts ↗</button></div>
      </div>
    <section class="cp-position ui-rise" aria-label="Financial position">
      <div class="cp-wealth">
        <span class="cp-eyebrow">NET WORTH${cockpitExRet?' · EX-RETIREMENT':''}</span>
        <strong class="ui-hero-value" id="cp-hero" data-source="${hero.source}">${hero.value==null?'—':UI.money(hero.value)}</strong>
        <div class="cp-hero-meta">${UI.prov(hero.source)}${hero.partial?cockpitGapPanel(s,d):''}</div>
        <p>${e(hero.note)}</p>
        <button onclick="cockpitGo('overview')">See the composition <span>${UI.icon('arrow')}</span></button>
      </div>
      <div class="cp-metrics">${
        metric('Cash + taxable',available?money(s.accessible):money(selected.liq),available?'Spendable without penalty':'Projected · accounts unavailable','overview')
      }${metric('Vested Stripe',available?money(s.stripeVested):money(selected.sEnd),'Private equity · sale windows apply','stripe')
      }${metric('Retirement',available?money(s.byClass?.retirement?.total):money(selected.k401),cockpitExRet?'Locked until 59½ · NOT in the figure above':available?'Locked until retirement age':'Projected · accounts unavailable','holdings')
      }${metric(`${current.yr} monthly margin`,money(current.flowMonthly),'All after-tax pay less all spending','cashflow')}</div>
    </section>
    </section>

    <div class="cp-workspace"><div class="cp-main-column">
      <section class="cp-register" data-tense="ahead">
        <div class="cp-register-head">
          <span class="ui-eyebrow">Where you are heading</span>
          <span class="cp-register-note">Projected from your plan. Not a forecast.</span>
        </div>
      <section class="cp-card cp-trajectory"><div class="cp-section-head"><div><h3>The path ahead</h3></div><button onclick="cockpitGo('home')">Explore a what-if ↗</button></div>
      <div class="cp-chart-summary"><div><span id="cp-year">${selected.yr} year-end ${cpLabel()}</span><strong id="cp-value">${UI.money(deflate(cpNw(selected),selected.yr))}</strong>${R[0].stubFrac<1?`<small class="cp-stub">${R[0].yr} models only the ${Math.round(R[0].stubFrac*100)}% of the year still ahead of ${e(cockpitObservedLabel(P))}. The months before it are already in your balances.</small>`:''}</div><span id="cp-band-note">${cockpitExRet?'Excludes retirement':'Includes retirement'}<br>${inflationView?(P.planStartYear||2026)+' purchasing power':'Future dollars'} · assumed returns</span></div>
      <label class="cp-basis"><input type="checkbox" id="cp-inc-ret"${cockpitExRet?'':' checked'}
        onchange="cockpitSetExRet(!this.checked)">
        <span>Include retirement</span>
        <em>${cockpitExRet?'Off — showing what you can reach before 59½':'On — showing everything you own'}</em>
      </label>
      <div class="cp-chart"><canvas id="cockpitTrajectory" aria-label="Projected wealth and liquid investments by year" role="img"></canvas></div>
      <div class="cp-pins" id="cp-pins"></div>
      <label class="cp-scrub" for="cp-year-range">Explore a year<input id="cp-year-range" type="range" min="${R[0].yr}" max="${end.yr}" value="${selected.yr}" oninput="cockpitSelectYear(Number(this.value))"><output id="cp-range-label">${selected.yr}</output></label>
      <div class="cp-year-grid" id="cp-year-grid"></div>
      <div id="cp-bridge"></div>
      <details class="cp-evidence"><summary>Show me why</summary><p>These are year-end estimates from your saved plan assumptions. Net worth here is modeled liquid investments, Stripe, home equity and retirement, less the revolving balance your plan carries. That balance is held flat rather than paid down — right for cards cleared monthly, wrong for a term loan, which would need its own amortisation. The account balances above are separate observations; this chart is not a historical performance record.</p><button onclick="cockpitGo('table')">Inspect the yearly calculations ↗</button></details></section>
      <section class="cp-card"><div class="cp-section-head"><div><h3>Explore your plan</h3></div></div><div class="cp-decisions">
      <button onclick="cockpitGo('housing')"><span>01 / HOME</span><strong>Find your buying range</strong><small>Timing, down payment & funding →</small></button>
      <button onclick="cockpitGo('spending')"><span>02 / EVERYDAY LIFE</span><strong>Understand your spending</strong><small>Transactions, categories & history →</small></button>
      <button onclick="cockpitGo('holdings')"><span>03 / INVESTMENTS</span><strong>See your exposure</strong><small>Positions, allocation & concentration →</small></button></div></section>
      </section>
    </div><aside class="cp-advisor">
      <section class="cp-register" data-tense="attention">
        <div class="cp-register-head">
          <span class="ui-eyebrow">What needs you</span>
        </div>
      <section class="cp-card cp-attention"><div class="cp-section-head"><div><h3>Priorities</h3></div><span class="cp-count">${priorities.length||'—'}</span></div>
      ${_inboxError?'<p>Checks could not load. Open the watchlist to retry.</p>':!_inbox?'<p role="status">Reading your watchlist…</p>':priorities.length?priorities.map((a,i)=>`<button class="cp-signal" onclick="cockpitGo('watch')"><span>0${i+1}</span><div><strong>${e(a.title||a.kind||'Review this signal')}</strong><small>Review evidence & assumptions ↗</small></div></button>`).join(''):'<p>No priorities returned by the checks that ran.</p>'}
      ${_inbox?`<p class="cp-meta">${Number(_inbox.checksRun)||0} of ${Number(_inbox.checksTotal)||0} checks ran; ${(_inbox.notChecked||[]).length} comparisons unavailable. Signals depend on source coverage and model assumptions.</p>`:''}<button class="cp-text-link" onclick="cockpitGo('watch')">Open full watchlist →</button></section>
      <section class="cp-card cp-intelligence"><span class="cp-eyebrow">ADVISOR</span><h3>Think it through.</h3><p>Bring a question. Explore the trade-offs with your plan in view.</p>
      <button onclick="cockpitQuestion('What are the three most consequential decisions in my current plan? Show the evidence, source dates, uncertainty and what would change your recommendation.')">What deserves my attention? ↗</button>
      <form onsubmit="event.preventDefault();cockpitQuestion(this.elements.question.value)"><label for="cp-question">Your question</label><textarea id="cp-question" name="question" required placeholder="What if I changed jobs…" rows="2"></textarea><button class="cp-button" type="submit">Prepare in advisor →</button></form><small>You review the question before sending.</small></section>
      </section>
      <div class="cp-floor"><span>Lowest projected liquid investments</span><strong>${money(floor.liq)} <small>in ${floor.yr}</small></strong><button onclick="cockpitGo('home')">Explore the pressure point →</button></div>
    </aside></div></div>`;
  cockpitDrawChart(R,P,selected.yr);
  cockpitSelectYear(selected.yr);
  // One animated number on the page, once. Everything else is still.
  if(hero.value!=null)UI.countUp(document.getElementById('cp-hero'),hero.value);
}
// ── The trajectory, as an instrument ─────────────────────────────────────────
// Three things separate a chart you read from one you use, and the old version had
// none of them:
//   1. A BAND. One line implies a precision the model does not have. The p10–p90 of a
//      Monte Carlo behind the median says "somewhere in here" honestly.
//   2. MILESTONES. The shape of the curve is meaningless until you can see WHY it bends
//      — the home purchase, a child starting school, the year the floor is tightest.
//   3. A SCRUB THAT MOVES EVERYTHING. Dragging the year re-renders the hero and every
//      figure on the page, so the chart is a control rather than a picture.
let _cpBand=null,_cpBandSig='';

function cockpitMilestones(R,P){
  const pins=[];
  if(typeof PlannerDecisions!=='undefined'&&PlannerDecisions.milestones)
    for(const m of PlannerDecisions.milestones(P,R))pins.push({yr:m.yr,label:m.label,kind:m.kind});
  // The tightest year is not a life event, but it is the one the reader most needs to see
  // — PROVIDED there is a tight year at all. When the retention policy holds the pool
  // exactly on its reserve floor, dozens of years tie at the minimum and "the low point"
  // is an artefact of which one the reduce happened to keep. A pin there would point at
  // nothing. Only a genuine breach gets marked.
  const reserve=Number(P&&(P.liquidReserveFloor??P.stripeLiquidFloor));
  const floor=R.reduce((a,b)=>b.liq<a.liq?b:a);
  const breaches=Number.isFinite(reserve)&&floor.liq<reserve-1;
  if(breaches)pins.unshift({yr:floor.yr,label:'Liquid low point',kind:'risk'});

  // One pin per year: several events in the same year become one marker, counted. The
  // risk pin is unshifted above so it claims its year rather than being absorbed.
  const byYear=new Map();
  for(const pin of pins){
    const e=byYear.get(pin.yr);
    if(e)e.extra=(e.extra||0)+1;else byYear.set(pin.yr,{...pin});
  }
  return[...byYear.values()].sort((a,b)=>a.yr-b.yr);
}

// Vertical rules at the milestone years, drawn under the data so they never obscure it.
const cpMilestonePlugin={
  id:'cpMilestones',
  beforeDatasetsDraw(chart,args,opts){
    const pins=opts&&opts.pins;if(!pins||!pins.length)return;
    const{ctx,chartArea:{top,bottom},scales:{x}}=chart;
    ctx.save();
    for(const pin of pins){
      const px=x.getPixelForValue(pin.yr);
      if(!Number.isFinite(px))continue;
      ctx.beginPath();
      ctx.setLineDash([3,5]);
      ctx.lineWidth=1;
      ctx.strokeStyle=pin.kind==='risk'?'rgba(236,193,131,.5)':'rgba(167,190,221,.22)';
      ctx.moveTo(px,top);ctx.lineTo(px,bottom);ctx.stroke();
    }
    ctx.restore();
  },
};

// "Incomplete" on its own is a word, not information: it tells the reader something is
// wrong without saying what, how much, or what to do. This opens into the actual list —
// which accounts returned nothing, and the two real ways out of it.
//
// There is deliberately no "dismiss" that leaves the total short while hiding the warning.
// The honest ways to stop seeing this are to supply the balance or to exclude the account,
// and both are offered here. Neither one invents a number: a confirmed balance is recorded
// as the reader's own dated figure, and an excluded account leaves the totals rather than
// being counted as zero.
function cockpitGapPanel(summary,overview){
  const e=advEscape;
  const missing=(summary&&summary.unknownBalance)||[];
  // Same reasoning as the chip that opens this panel: only the reading on screen counts.
  const syncPartial=!!(overview&&overview.partial);
  const rows=missing.map(a=>`<li>
    <span>${e(a.name||a.id)}</span>
    <button type="button" onclick="confirmAccountBalance('${e(String(a.id))}','${e(String(a.name||'').replace(/'/g,''))}',${JSON.stringify(a.rawMissing==null?null:String(a.rawMissing))})">Enter the balance</button>
    <button type="button" onclick="setAccountHidden('${e(String(a.id))}',true,${JSON.stringify(a.name||'')})">Exclude it</button>
  </li>`).join('');
  return `<details class="cp-gap">
    <summary aria-label="Why this total is incomplete">${UI.prov('missing','incomplete')}</summary>
    <div class="cp-gap-body" role="group">
      <strong>Your net worth is short by an unknown amount.</strong>
      <p>${missing.length
        ? `${missing.length} account${missing.length===1?'':'s'} returned no balance. ${missing.length===1?'It is':'They are'} counted <em>nowhere</em> above — not as zero — because a balance nobody could read is not the same as an empty account.`
        : syncPartial
          ? 'The last sync did not return every account, so the figure above covers only the accounts that did report.'
          : 'Some balances could not be read, so the figure above covers only the accounts that did report.'}</p>
      ${rows?`<ul>${rows}</ul>
      <p class="cp-gap-fine">Entering a balance records it as <em>your</em> figure, dated today; a real balance from Monarch supersedes it automatically. Excluding an account takes it out of the totals and says so — it is never counted as zero.</p>`:''}
      <button type="button" class="cp-gap-link" onclick="cockpitGo('overview')">Open accounts ↗</button>
    </div>
  </details>`;
}

// The observation date, written the way a person would say it.
function cockpitObservedLabel(P){
  if(!P||!P.observedOn)return 'the start of the year';
  const t=Date.parse(/T/.test(P.observedOn)?P.observedOn:P.observedOn+'T00:00:00Z');
  if(!Number.isFinite(t))return 'the start of the year';
  return new Date(t).toLocaleDateString(undefined,{month:'long',day:'numeric',timeZone:'UTC'});
}

function cockpitDrawChart(R,P,year){
  // Same x-axis and same opening anchor as the Trajectory tab: a prior-year point holding
  // the plan's whole opening position. Starting at R[0] instead made the two charts begin
  // at different places on different values, which is most of what "they don't line up"
  // looked like even before the figures were compared.
  const sy=P.planStartYear||2026;
  const opening=Math.round((P.startingLiquid||0)+(P.startingStripeEquity||0)+(P.k401Start||0)
    -Math.abs(Number(P.otherDebt||0)));
  const labels=[sy-1,...R.map(r=>r.yr)];
  const pins=cockpitMilestones(R,P);

  // The band is expensive, so it is cached against the plan it was computed from. A
  // stale band drawn over a changed plan would be worse than no band at all.
  const sig=JSON.stringify(P);
  if(_cpBandSig!==sig){
    _cpBand=null;_cpBandSig=sig;
    try{const mc=runMonteCarlo(P,250,'lognormal');_cpBand={total:mc.band,exRet:mc.bandExRet}}catch(e){_cpBand=null}
  }
  const band=_cpBand?(cockpitExRet?_cpBand.exRet:_cpBand.total):null;
  const note=document.getElementById('cp-band-note');
  if(note)note.innerHTML=band
    ? `Median of 250 simulated paths<br>Shaded band spans the 10th to 90th percentile${inflationView?`<br>${sy} purchasing power`:''}`
    : `${cockpitExRet?'Excludes retirement':'Includes retirement'}<br>${inflationView?sy+' purchasing power':'Future dollars'} · assumed returns`;

  const ds=[];
  if(band){
    // Drawn as a filled region between two invisible lines: the reader should see an
    // area of uncertainty, not two more curves competing with the median.
    ds.push({label:'90th percentile',data:[null,...band.p90.map((v,i)=>deflate(v,R[i].yr))],borderColor:'transparent',
      backgroundColor:'rgba(122,227,195,.09)',fill:'+1',pointRadius:0,borderWidth:0,tension:.25});
    ds.push({label:'10th percentile',data:[null,...band.p10.map((v,i)=>deflate(v,R[i].yr))],borderColor:'transparent',
      backgroundColor:'transparent',fill:false,pointRadius:0,borderWidth:0,tension:.25});
  }
  ds.push({label:cockpitExRet?'Net worth ex-retirement':'Net worth incl. retirement',
    data:[cockpitExRet?opening-Math.abs(Number(P.k401Start||0)):opening,...R.map(r=>deflate(cpNw(r),r.yr))],
    borderColor:'#7ae3c3',backgroundColor:'transparent',fill:false,
    pointRadius:0,pointHoverRadius:5,borderWidth:2.5,tension:.25});
  ds.push({label:'Liquid investments',data:[P.startingLiquid||0,...R.map(r=>deflate(r.liq,r.yr))],
    borderColor:'#b6a8ff',borderDash:[4,4],pointRadius:0,borderWidth:1.8,tension:.25});

  charts.cockpit=new Chart(document.getElementById('cockpitTrajectory'),{
    type:'line',
    data:{labels,datasets:ds},
    options:{
      responsive:true,maintainAspectRatio:false,
      // The line draws itself once, left to right, and never again. Chart.js has no
      // native left-to-right reveal, so the x scale is animated from 0.
      animation:_reduceMotion()?false:{x:{from:0,duration:900,easing:'easeOutCubic'},y:{duration:0}},
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{position:'bottom',labels:{color:'#acb9cc',boxWidth:14,font:{size:12},
          filter:i=>!/percentile/.test(i.text)}},
        tooltip:{callbacks:{
          label:c=>/percentile/.test(c.dataset.label)?null:`${c.dataset.label}: ${UI.money(c.raw)}`,
          afterBody:items=>{
            const yr=Number(items[0].label);
            const hit=pins.filter(p=>p.yr===yr);
            return hit.length?hit.map(p=>p.label):[];
          },
        }},
        cpMilestones:{pins},
      },
      scales:{
        x:{grid:{display:false},ticks:{color:'#899ab1',maxTicksLimit:6}},
        y:{grid:{color:'rgba(167,190,221,.07)'},ticks:{color:'#899ab1',callback:v=>UI.money(v)}},
      },
    },
    plugins:[cpMilestonePlugin],
  });

  // The pins are clickable below the axis rather than crowded onto it: a label on a
  // 240px chart is unreadable, and a target you can hit is more use than one you can see.
  const rail=document.getElementById('cp-pins');
  if(rail)rail.innerHTML=pins.map(p=>
    `<button type="button" data-kind="${p.kind}" onclick="cockpitSelectYear(${p.yr})">
      <span>${p.yr}</span>${advEscape(p.label)}${p.extra?` +${p.extra}`:''}</button>`).join('');
}

// ── The scrub moves the whole page ───────────────────────────────────────────
// This is the difference between a chart and a cockpit. Dragging the year updates the
// hero, the supporting metrics and the year grid together, so the reader can watch their
// whole financial life recompute rather than reading one number off a line.
function cockpitSelectYear(year){
  cockpitYear=year;
  const R=run(P).R;
  const row=R.find(r=>r.yr===year);if(!row)return;
  const set=(id,text)=>{const el=document.getElementById(id);if(el)el.textContent=text};
  set('cp-year',year+' year-end '+cpLabel());
  set('cp-value',UI.money(deflate(cpNw(row),row.yr)));
  set('cp-range-label',year);

  // The hero follows the scrub only while it is showing a PROJECTED figure. An observed
  // balance belongs to today and must not be relabelled as some future year's.
  const hero=document.getElementById('cp-hero');
  if(hero&&hero.dataset.source==='projected')hero.textContent=UI.money(deflate(cpNw(row),row.yr));

  const grid=document.getElementById('cp-year-grid');
  if(grid)grid.innerHTML=[['Liquid investments',row.liq],['Vested Stripe',row.sEnd],
    ['Home equity',row.eq]].map(([label,value])=>
    `<div><span>${label}</span><strong class="ui-num">${UI.money(deflate(value,row.yr))}</strong></div>`).join('');

  const rail=document.getElementById('cp-pins');
  if(rail)for(const b of rail.querySelectorAll('button'))
    b.classList.toggle('is-current',Number(b.firstElementChild.textContent)===year);

  cockpitRenderBridge(R,year);
}

// ── Why the two big numbers differ ───────────────────────────────────────────
// The page shows net worth twice: observed at the top, projected on the chart. They do not
// agree, and a cockpit that presents both without accounting for the distance is asking the
// reader to assume one of them is broken. This walks from one to the other in lines that
// add up, and separates the difference that can be fixed (the plan's opening figures are
// stale) from the two that cannot (the projection models fewer things; today is not 31
// December).
function cockpitRenderBridge(R,year){
  const host=document.getElementById('cp-bridge');
  if(!host||!window.PlannerBridge)return;
  const e=advEscape,d=_ovw,s=d?.summary;
  const available=!!s&&!d.error&&d.capabilities?.balances?.available===true;
  const b=PlannerBridge.bridge({summary:s,R,P,year,accountsAvailable:available,exRetirement:cockpitExRet});
  if(!b.available){host.innerHTML='';return}

  // Exact dollars, not $1.58M. This is the one table on the page whose entire claim is that
  // the lines reconcile, and rounded steps do not visibly add up.
  const row=l=>`<div class="cp-bridge-row" data-kind="${l.kind}">
    <span>${e(l.label)}</span>
    <em class="ui-num">${l.value==null?'':UI.money(l.value,{exact:true,signed:true})}</em>
    <strong class="ui-num">${l.running==null?'':UI.money(l.running,{exact:true})}</strong>
    <small>${e(l.note)}${l.action==='reconcile'?' <button onclick="cockpitGo(\'overview\')">Reconcile with your accounts ↗</button>':l.action==='classify'?' <button onclick="cockpitGo(\'overview\')">Classify them ↗</button>':''}</small>
  </div>`;

  host.innerHTML=`<details class="cp-bridge"${b.aligned?'':' open'}>
    <summary><span class="ui-eyebrow">Observed vs. projected</span>
      <span class="cp-bridge-headline${b.aligned?'':' is-gap'}">${e(b.headline)}</span></summary>
    <div class="cp-bridge-rows">${b.lines.map(row).join('')}</div>
    ${b.caveats.length?`<p class="cp-bridge-caveat">${b.caveats.map(e).join(' ')}</p>`:''}
  </details>`;
}

function mountSpendingCharts({rows,months,asOf,verified}){
  const palette=['#7ae3c3','#a99bff','#78b7ef','#efb873','#ed91b0','#6dcacb','#bbc884','#748db5'];
  const positive=rows.filter(r=>r.net>0),top=positive.slice(0,7),other=positive.slice(7).reduce((s,r)=>s+r.net,0);
  const slices=other?[...top,{name:'Other categories',net:other}]:top;
  const total=slices.reduce((s,r)=>s+r.net,0);
  const dollars=v=>fmtF(Math.round(v));
  const legend=document.getElementById('spendCategoryLegend');
  legend.innerHTML=slices.length?slices.map((r,i)=>`<div><span class="spend-key" style="background:${palette[i]}"></span><span>${advEscape(r.name)}</span><strong>${dollars(r.net)}</strong><small>${(r.net/total*100).toFixed(1)}%</small></div>`).join(''):'<p>No positive category spending in this period.</p>';
  charts.spendingCategories=new Chart(document.getElementById('spendCategoryChart'),{type:'doughnut',data:{labels:slices.map(r=>r.name),datasets:[{data:slices.map(r=>r.net),backgroundColor:palette,borderColor:'#111b2b',borderWidth:4,hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:'72%',plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${c.label}: ${dollars(c.raw)} (${(c.raw/total*100).toFixed(1)}%)`}}}}});
  charts.spendingMonths=new Chart(document.getElementById('spendMonthlyChart'),{type:'bar',data:{labels:months.map(m=>m.month+(m.month===asOf.slice(0,7)?' · partial':verified.includes(m.month)?'':' *')),datasets:[{label:'Income',data:months.map(m=>m.income||0),backgroundColor:'#72cbb0',borderRadius:4},{label:'Spending',data:months.map(m=>m.expense||0),backgroundColor:'#a798ef',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{labels:{color:'#bdc9dc',font:{size:13},boxWidth:12}},tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${dollars(c.raw)}`}}},scales:{x:{ticks:{color:'#aabbd0',maxRotation:60,font:{size:12}},grid:{display:false}},y:{ticks:{color:'#aabbd0',callback:v=>fmt(v)},grid:{color:'#27364b'}}}}});
  if(months.some(m=>m.month!==asOf.slice(0,7)&&!verified.includes(m.month))){
    const note=document.createElement('p');note.className='spend-caption';note.textContent='* Full-month import coverage has not been verified.';document.getElementById('spendMonthlyChart').parentElement.after(note);
  }
}
