'use strict';
let stripeWorkspace='overview';
// Fields the reader enters in billions and the model stores in dollars.
const STRIPE_BILLIONS=['referenceValuation','valuationCeiling'];
function stripeWorkspaceSet(view){stripeWorkspace=['overview','prices','income'].includes(view)?view:'overview';render();}
function stripeWorkspaceNav(){return `<nav class="sg-nav" aria-label="Stripe workspace">${[['overview','Position'],['income','Compensation'],['prices','Valuation path']].map(([v,l])=>`<button class="${stripeWorkspace===v?'active':''}" aria-current="${stripeWorkspace===v?'page':'false'}" onclick="stripeWorkspaceSet('${v}')">${l}</button>`).join('')}</nav>`;}
function stripeGrantIntro(){return '';}
function stripeManualSet(year,key,value){
  if(value.trim()===''||!Number.isFinite(Number(value))||Number(value)<0){showToast('Enter a non-negative annual amount.','red');return;}
  const i=year-(P.planStartYear||2026), n=Number(value);
  if(i<11)P['norm'+(key==='cash'?'Cash':'Stock')+'Y'+i]=n;
  else P.stripeManualLater={...P.stripeManualLater,[year]:{...normComp(P,i),[key]:n}};
  markDirty();buildControls();savePlannerState();
  // Deliberately NOT render(). This fires on blur, once per cell, while you are working
  // down a column of thirty-three years — and a full re-render replaces the table, which
  // threw away its scroll position and the focus Tab had just moved on to. Every figure the
  // edit changes is updated in place instead; the rest of the app re-renders on the next
  // tab change, which is the first time any of it is on screen.
  stripeRefreshComp();
}
// A later year's amounts can be derived from an earlier one, so one edit can move many rows.
// Every row is refreshed, except a field the reader is currently typing into.
function stripeRefreshComp(){
  const sy=P.planStartYear||2026, ey=P.planEndYear||2058;
  for(let y=sy;y<=ey;y++){
    const n=normComp(P,y-sy);
    const tot=document.getElementById('sg-total-'+y);
    if(tot)tot.textContent=fmt(n.cash+n.stock);
    for(const k of ['cash','stock']){
      const el=document.getElementById(`sg-comp-${k}-${y}`);
      if(el&&el!==document.activeElement)el.value=Math.round(n[k]);
    }
  }
}
function stripeGrantSet(key,value){
  const raw=value===''?null:Number(value);
  if(raw!==null&&(!Number.isFinite(raw)||raw<0||(key==='priceYear'&&(!Number.isInteger(raw)||raw<2000||raw>2100)))){showToast('Enter a valid non-negative value.','red');return;}
  // Valuations are entered and shown in billions; the model works in dollars.
  const n=raw!==null&&STRIPE_BILLIONS.includes(key)?raw*1e9:raw;
  P.stripeGrants={...StripeGrants.setup(P),...P.stripeGrants,enabled:false,[key]:n};
  // Relative prices suffice for a valuation path; manual compensation needs no share price.
  if(!(P.stripeGrants.referenceTender>0))P.stripeGrants.referenceTender=1;
  markDirty();savePlannerState();
  stripeKeepFocus(render);
}
// A field that redraws the panel around itself loses the caret with it. Restores focus and
// the selection to the same field afterwards, plus any scrolled table's position.
function stripeKeepFocus(fn){
  // Never let restoring the cursor cost someone their edit: without a live DOM this is just fn().
  if(typeof document==='undefined'||!document.querySelectorAll)return fn();
  const a=document.activeElement;
  const id=a&&a.id&&document.getElementById('chartArea')?.contains(a)?a.id:null;
  const sel=id?[a.selectionStart,a.selectionEnd]:null;
  const tops=[...document.querySelectorAll('#chartArea .sg-table-wrap')].map(w=>w.scrollTop);
  fn();
  document.querySelectorAll('#chartArea .sg-table-wrap').forEach((w,i)=>{if(tops[i])w.scrollTop=tops[i]});
  if(!id)return;
  const el=document.getElementById(id);
  if(!el)return;
  el.focus();
  try{if(sel&&sel[0]!=null)el.setSelectionRange(sel[0],sel[1])}catch(_){/* number inputs refuse a range in some browsers */}
}
function renderStripeWorkspace(R){
  const sy=P.planStartYear||2026,ey=P.planEndYear||2058,c={...StripeGrants.setup(P),...P.stripeGrants};
  const esc=s=>String(s).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
  let h=stripeWorkspaceNav()+`<header class="ui-head"><div><span class="ui-eyebrow">STRIPE EQUITY</span><h2>${stripeWorkspace==='income'?'Your compensation. Your assumptions.':'The valuation behind the plan.'}</h2></div></header>`;
  if(stripeWorkspace==='income'){
    h+=`<section class="sc"><p>Cash includes salary, bonus and cash awards. Stock is gross compensation at vesting, including the upside you expect. These inputs feed every projection.</p><div class="sg-table-wrap"><table><thead><tr><th>Year</th><th>Cash compensation</th><th>Stock compensation at vesting</th><th>Total</th></tr></thead><tbody>${Array.from({length:ey-sy+1},(_,i)=>{const n=normComp(P,i);return `<tr><th>${sy+i}</th>${['cash','stock'].map(k=>`<td><input id="sg-comp-${k}-${sy+i}" type="number" min="0" step="any" aria-label="${sy+i} ${k} compensation" value="${Math.round(n[k])}" onchange="stripeManualSet(${sy+i},'${k}',this.value)"></td>`).join('')}<td id="sg-total-${sy+i}">${fmt(n.cash+n.stock)}</td></tr>`;}).join('')}</tbody></table></div><p class="sg-note">Years after ${sy+10} follow the growth assumptions unless you enter an annual amount. Previously calculated amounts have been preserved as manual inputs.</p></section>`;
  }else{
    // Billions in, billions out. The field used to be labelled in dollars, so "160" — the
    // only way anyone writes $160B — was read as one hundred and sixty dollars and every
    // figure downstream rounded to $0B.
    const field=(label,key,v)=>{
      const shown=v==null?'':STRIPE_BILLIONS.includes(key)?v/1e9:v;
      return `<label class="sg-field"><span>${label}</span><input id="sg-grant-${key}" type="number" min="0" step="any" value="${shown}" onchange="stripeGrantSet('${key}',this.value)"></label>`;
    };
    h+=`<section class="sc"><h3>Company valuation</h3><div class="sg-fields">${field('Reference valuation ($B)','referenceValuation',c.referenceValuation)}${field('Reference February year','priceYear',c.priceYear)}${field('Valuation ceiling ($B, optional)','valuationCeiling',c.valuationCeiling)}</div><p class="sg-note">Growth for 2026 appears at the February 2027 tender, and so on. Holdings follow the same price path; compensation remains your manual estimate. With no dilution, valuation and share price grow proportionally.</p>${c.dilutionRate>0?`<p class="sg-note">Your existing ${(c.dilutionRate*100).toFixed(1)}% annual dilution assumption is preserved.</p>`:''}</section>`;
    if(c.referenceValuation>0){
      const candidates=[{name:'Current plan',p:P},...scenarios.map(s=>({name:s.name||'Saved scenario',p:scenarioPlan(s.params)}))];
      const paths=candidates.map(x=>({...x,prices:StripeGrants.pricePath({...x.p,stripeGrants:{...c,...x.p.stripeGrants}},sy,ey)}));
      // A positive valuation must never print as $0B: below a billion, say so in its own unit.
      // Whole numbers, and a positive valuation never prints as $0B: below a billion, say it
      // in its own unit rather than rounding it away.
      const bn=v=>!(v>0)?'$0':v>=1e9?'$'+Math.round(v/1e9).toLocaleString('en-US')+'B'
        :v>=1e6?'$'+Math.round(v/1e6).toLocaleString('en-US')+'M'
        :'$'+Math.round(v).toLocaleString('en-US');
      h+=stripeGrantChart(Object.values(paths[0].prices).filter(p=>p.year>=sy&&p.year<=ey).map(p=>({year:p.year,value:p.valuation})),'Company valuation · current scenario',bn);
      h+=`<details class="sc polish-fold refine-fold"><summary>Year-by-year scenario values</summary><div class="sg-table-wrap"><table><thead><tr><th>February</th>${paths.map(x=>`<th>${esc(x.name)}</th>`).join('')}</tr></thead><tbody>${Array.from({length:ey-sy+1},(_,i)=>`<tr><th>${sy+i}</th>${paths.map(x=>`<td>${bn(x.prices[sy+i].valuation)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
    }else h+=`<section class="sc"><p>Enter a reference company valuation to see its projected value each year and compare your saved scenarios.</p></section>`;
    h+=`<details class="sc polish-fold"><summary>Edit growth assumptions · selected scenario</summary><div class="sg-fields">${Array.from({length:10},(_,i)=>`<label class="sg-field"><span>${sy+i} growth → Feb ${sy+i+1}</span><input type="number" min="-99" max="300" step="1" value="${((P['stripeRetY'+i]??.08)*100).toFixed(1)}" onchange="U('stripeRetY${i}',Number(this.value)/100)"></label>`).join('')}<label class="sg-field"><span>Long-term growth %</span><input type="number" min="-99" max="100" value="${((P.stripeLongTermReturn??.08)*100).toFixed(1)}" onchange="U('stripeLongTermReturn',Number(this.value)/100)"></label>${field('Annual dilution (0.01 = 1%)','dilutionRate',c.dilutionRate)}</div></details>`;
  }
  document.getElementById('chartArea').innerHTML=`<div class="sg-workspace">${h}</div>`;
}
function stripeGrantChart(points,label,format){
  const max=Math.max(1,...points.map(p=>p.value)),min=Math.min(0,...points.map(p=>p.value));
  const xy=points.map((p,i)=>[40+i*820/Math.max(1,points.length-1),155-(p.value-min)/(max-min)*115]);
  const marks=[0,Math.floor((points.length-1)/2),points.length-1];
  // Every year of the path is readable, not just the three that fit as labels: the chart
  // carries its own points and reports whichever one the pointer is nearest.
  const hover=points.map((p,i)=>[String(p.year),format(p.value),Math.round(xy[i][1]*100)/100]);
  return `<figure class="sg-chart"><figcaption>${label} <span class="sg-chart-read" data-idle="Projected · selected scenario">Projected · selected scenario</span></figcaption><svg viewBox="0 0 900 190" role="img" aria-label="${label}: ${format(points[0].value)} in ${points[0].year}, ${format(points.at(-1).value)} in ${points.at(-1).year}" data-pts='${JSON.stringify(hover)}' onpointermove="stripeChartHover(event,this)" onpointerleave="stripeChartLeave(this)"><line x1="40" y1="155" x2="860" y2="155" stroke="var(--bd)"/><line class="sg-cross" x1="40" y1="24" x2="40" y2="155" stroke="#8b80ff" stroke-width="1" stroke-dasharray="3 3" opacity="0"/><polyline points="${xy.map(p=>p.join(',')).join(' ')}" fill="none" stroke="#8b80ff" stroke-width="3"/>${marks.map(i=>`<circle cx="${xy[i][0]}" cy="${xy[i][1]}" r="4" fill="#8b80ff"/>`).join('')}<circle class="sg-hoverdot" r="6" fill="#8b80ff" stroke="var(--s1)" stroke-width="2" opacity="0"/></svg><div class="sg-chart-labels">${marks.map(i=>`<span>${points[i].year}<strong>${format(points[i].value)}</strong></span>`).join('')}</div></figure>`;
}
// Nearest-year readout. The pointer never has to land on a point; it picks the closest.
function stripeChartHover(e,svg){
  let pts;try{pts=JSON.parse(svg.dataset.pts||'[]')}catch(_){return}
  if(!pts.length)return;
  const r=svg.getBoundingClientRect();if(!r.width)return;
  const step=pts.length>1?820/(pts.length-1):0;
  const i=Math.max(0,Math.min(pts.length-1,step?Math.round(((e.clientX-r.left)/r.width*900-40)/step):0));
  const cx=40+i*step, cross=svg.querySelector('.sg-cross'), dot=svg.querySelector('.sg-hoverdot');
  cross.setAttribute('x1',cx);cross.setAttribute('x2',cx);cross.setAttribute('opacity','1');
  dot.setAttribute('cx',cx);dot.setAttribute('cy',pts[i][2]);dot.setAttribute('opacity','1');
  const out=svg.parentElement.querySelector('.sg-chart-read');
  if(out){out.textContent=`${pts[i][0]} · ${pts[i][1]}`;out.classList.add('live');}
}
function stripeChartLeave(svg){
  svg.querySelector('.sg-cross')?.setAttribute('opacity','0');
  svg.querySelector('.sg-hoverdot')?.setAttribute('opacity','0');
  const out=svg.parentElement.querySelector('.sg-chart-read');
  if(out){out.textContent=out.dataset.idle||'';out.classList.remove('live');}
}
