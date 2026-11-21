'use strict';
let purchaseManualElection=false,purchaseFocus=null;
function purchaseFunding(p,rows,quarter,pause,cap,stress=false){
  return PurchaseDecision.closing(p,rows,{quarter,pause,cap,stress,manualElection:purchaseManualElection,need:cashToClose(p.homePrice,p).total});
}
const pdMoney=v=>UI.money(v,{exact:false}),pdSigned=v=>(v<0?'−':'+')+pdMoney(Math.abs(v));
const pdShare=v=>Number.isFinite(v)?(v*100).toFixed(1)+'%':'No take-home';
function mountPurchaseDecision({q,rows},views,controls,hs){
  const quarter=_afQuarter||PlannerLiquidity.purchaseQuarter(q),floor=q.liquidReserveFloor??500000;
  const score=(p,rs)=>PurchaseDecision.assess(p,rs,housingYears(p,rs,_afShare),purchaseFunding(p,rs,quarter,_afPauseMonths,_afTenderCap));
  const d=score(q,rows);if(!d)return;
  const f=d.funds,over=d.peak?.share>_afShare+.000001;
  const verdict=f.elapsed?'Choose a future closing quarter.':!f.fundable?pdMoney(f.shortfall)+' short at closing.':d.margin<-.99?pdMoney(-d.margin)+' below your reserve in '+d.low.yr+'.':over?'The purchase clears closing, but exceeds your housing target.':'The purchase clears all three checks.';
  const metric=(l,v,t)=>'<div><span>'+l+'</span><strong>'+v+'</strong><small>'+t+'</small></div>';
  const h=document.createElement('section');h.className='pd-verdict';
  h.innerHTML='<span class="pd-kicker">YOUR PURCHASE · '+pdMoney(q.homePrice)+' · '+q.homePurchaseYear+'</span><h3>'+verdict+'</h3><div class="pd-metrics">'+
    metric('Peak housing share',pdShare(d.peak?.share),Math.round(_afShare*100)+'% target · '+(d.peak?.year??'outside plan'))+
    metric('Available by Q'+quarter,f.elapsed?'Past quarter':pdMoney(f.available),pdMoney(f.need)+' to close')+
    metric('Lowest reserve',pdMoney(d.low.liq),d.low.yr+' · '+pdMoney(floor)+' floor')+'</div>';views.after(h);
  controls.querySelector('#exHomeLive')?.remove();
  const changed=Object.keys(_rbOv).length>0;
  const saved={...P,housingMode:'buy'},savedRows=changed?run(saved).R:rows;
  if(changed){
    const base=score(saved,savedRows);
    if(base)h.insertAdjacentHTML('beforeend','<p class="pd-compare">Compared with '+(P.housingMode==='rent'?'your original buy preview':'the saved purchase')+': '+pdSigned(d.margin-base.margin)+' at the reserve low · '+pdSigned((f.available-f.need)-(base.funds.available-base.funds.need))+' in closing headroom.</p>');
  }
  const alts=[['Buy one year later','homePurchaseYear',q.homePurchaseYear+1],['Put 5 points less down','downPctg',Math.max(0,q.downPctg-5)],['Lower price by $100K','homePrice',Math.max(0,q.homePrice-100000)]].filter(([,k,v])=>v!==q[k]&&v>0&&(k!=='homePurchaseYear'||v<=rows.at(-1).yr));
  const cost=housingMonthlyCost(q).all;
  const tests=alts.map(([label,k,v])=>{const p={...q,[k]:v},n=score(p,run(p).R);if(!n)return '';
    const pass=n.funds.fundable&&n.margin>=-1&&n.peak?.share<=_afShare;
    return '<button type="button" onclick="rbSet(\''+k+'\','+v+')"><b>'+label+'</b><span>'+pdSigned(n.margin-d.margin)+' at reserve low</span><small>'+(pass?'Clears all three':n.funds.elapsed?'Past closing quarter':!n.funds.fundable?pdMoney(n.funds.shortfall)+' short to close':n.margin<-1?pdMoney(-n.margin)+' below floor':pdShare(n.peak.share)+' peak housing share')+'</small></button>';
  }).join('');
  controls.insertAdjacentHTML('beforeend','<p class="pd-caption">'+pdMoney(cost)+'/month at purchase · select a change to preview it.</p><div class="pd-tests">'+tests+'</div>');
  const peak=PurchaseDecision.peakImpact(savedRows,rows,saved.homePurchaseYear);
  if(peak){
    const entry=(name,base,value,delta)=>'<div><span>'+name+'</span><strong>'+pdMoney(value)+'</strong><small>'+(delta?'<b data-gain="'+(delta>0)+'">'+pdSigned(delta)+'</b> vs '+pdMoney(base):'No change from '+pdMoney(base))+'</small></div>';
    controls.insertAdjacentHTML('afterend','<section class="pd-panel pd-peak" aria-label="Peak year impact"><span class="pd-kicker">PEAK PRESSURE · '+peak.year+'</span><h3>Impact in your tightest year</h3><div class="pd-peak-grid">'+
      entry('Annual cash flow',peak.base.flowFull,peak.preview.flowFull,peak.flowDelta)+entry('Year-end net worth',peak.base.netWorth,peak.preview.netWorth,peak.wealthDelta)+
      '</div><p class="pd-caption">Same year in both views: the tightest year in '+(P.housingMode==='rent'?'your original buy preview':'the saved purchase')+'. Cash flow is after-tax compensation, including vested stock, less annual spending. Amounts in future dollars.</p></section>');
  }
  const section=document.createElement('section');section.className='pd-section';hs.before(section);
  const source=(label,available,used)=>'<tr><th scope="row">'+label+'</th><td>'+pdMoney(available)+'</td><td>'+pdMoney(used)+'</td></tr>';
  section.innerHTML='<div class="pd-panel"><div class="pd-top"><div><span class="pd-kicker">CLOSING FUNDS</span><h3>'+(f.elapsed?'Closing quarter has passed':f.usedSales>0?pdMoney(f.usedSales)+' needs a Stripe sale.':f.shortfall>0?'Closing still needs '+pdMoney(f.shortfall)+'.':'No Stripe sale needed.')+'</h3></div><label>Closing quarter<select onchange="afSet2(\'q\',this.value)">'+[1,2,3,4].map(x=>'<option '+(x===quarter?'selected':'')+' value="'+x+'">Q'+x+'</option>').join('')+'</select></label></div>'+
    '<table class="pd-funding"><thead><tr><th>Source</th><th>Available</th><th>Used to close</th></tr></thead><tbody>'+
    source('Cash & taxable portfolio¹',f.portfolio,f.used)+source('Quarterly cash election',f.elective,f.usedElection)+source(f.free?'Stripe · open market':'Stripe · tender proceeds',f.shares,f.usedSales)+'</tbody></table>'+
    (f.shortfall>.01?'<p class="pd-warning">'+pdMoney(f.shortfall)+' still unfunded.</p>':'')+
    (!f.tracked&&!rows.find(r=>r.yr===q.homePurchaseYear)?.fiActive?'<label class="pd-check"><input type="checkbox" '+(purchaseManualElection?'checked':'')+' onchange="purchaseManualElection=this.checked;render()">Preview taking eligible stock pay in cash</label>':'')+
    '<details><summary>Funding assumptions</summary><p>¹ Above the reserve, after estimated sale taxes. Starts with opening balances; excludes other income and spending before closing'+(_afPauseMonths?' except the selected income-pause allowance':'')+'. Uses cash first, then elections, then sales. '+(f.tracked?'Cash elections follow scheduled grant payments.':'Manual pay: the election preview converts future stock within the configured quarterly and annual limits. It does not add income.')+' Timing is estimated to quarter-end.</p></details></div><div class="pd-panel" data-pd-family></div>';
  const family=section.querySelector('[data-pd-family]');drawFamilyTimeline(family,d);
}
function drawFamilyTimeline(host,d){
  const all=d.owned;let r=all.find(x=>x.yr===purchaseFocus)||d.tight;
  const children=r.childEducation||[],palette=['#548274','#a37a36','#798b4d','#9b6960'];
  const max=Math.max(1,...all.map(v=>Math.max(v.netTC,v.totEFull))),W=Math.max(560,all.length*23),H=128,dx=W/all.length,y=v=>H-(Math.max(0,v)/max)*(H-8);
  const bars=all.map((v,i)=>{let acc=0;const layers=[[v.hFull,'#2f604a'],...(v.childEducation||[]).map((c,i)=>[c.care+c.tuition,palette[i%4]]),[Math.max(0,v.totEFull-v.hFull-v.ccFull-v.tuFull),'#ced5c8']];
    return layers.map(([val,color])=>{const old=acc;acc+=val;return '<rect x="'+(i*dx+3)+'" y="'+y(acc)+'" width="'+Math.max(1,dx-6)+'" height="'+(y(old)-y(acc))+'" fill="'+color+'"/>';}).join('');
  }).join('');
  const line=all.map((v,i)=>(dx*(i+.5))+','+y(v.netTC)).join(' ');
  host.innerHTML='<div class="pd-top"><div><span class="pd-kicker">FAMILY CASH FLOW</span><h3>'+d.tight.yr+' is the tightest year.</h3></div><label>Inspect year<select data-year>'+all.map(v=>'<option '+(v.yr===r.yr?'selected':'')+'>'+v.yr+'</option>').join('')+'</select></label></div>'+
    '<div class="pd-legend"><span>━ Take-home incl. vested stock</span><span style="--sw:#2f604a">Housing</span>'+children.map((c,i)=>'<span style="--sw:'+palette[i%4]+'">Child '+c.child+'</span>').join('')+'<span style="--sw:#ced5c8">Other spending</span></div>'+
    '<div class="pd-scroll"><svg width="'+W+'" viewBox="0 0 '+W+' '+(H+23)+'" role="img" aria-label="Annual spending by category compared with take-home income. Select a year for exact values.">'+bars+'<polyline points="'+line+'" fill="none" stroke="#1e312d" stroke-width="2.6"/>'+all.map((v,i)=>'<g data-year="'+v.yr+'">'+(r===v?'<rect x="'+(i*dx+1)+'" y="1" width="'+(dx-2)+'" height="'+(H-1)+'" fill="none" stroke="#244b36" stroke-dasharray="3 3"/>':'')+((i%5===0||r===v)?'<text x="'+(dx*(i+.5))+'" y="'+(H+16)+'" text-anchor="middle" font-size="10">'+v.yr+'</text>':'')+'<rect x="'+i*dx+'" y="0" width="'+dx+'" height="'+(H+20)+'" fill="transparent"><title>'+v.yr+' · '+pdSigned(v.flowFull)+'</title></rect></g>').join('')+'</svg></div>'+
    '<div class="pd-year"><strong>'+r.yr+' · '+pdMoney(Math.abs(r.flowFull))+(r.flowFull<0?' deficit':' surplus')+'</strong><span>'+pdMoney(r.netTC)+' take-home − '+pdMoney(r.totEFull)+' spending</span></div>'+
    '<div class="pd-break"><span>Housing <b>'+pdMoney(r.hFull)+'</b></span>'+children.filter(c=>c.care||c.tuition).map(c=>'<span>Child '+c.child+' · '+(c.care?'care':'tuition')+' (age '+c.age+') <b>'+pdMoney(c.care+c.tuition)+'</b></span>').join('')+'<span>Living costs <b>'+pdMoney(r.totEFull-r.hFull-r.ccFull-r.tuFull-r.eAdj)+'</b></span>'+(r.eAdj?'<span>Events & adjustments <b>'+pdMoney(r.eAdj)+'</b></span>':'')+'</div>'+
    (r.eAdj>0?'<p class="pd-caption">Before events & adjustments: '+pdSigned(r.flowFull+r.eAdj)+'.</p>':'');
  const select=yr=>{const scroll=host.querySelector('.pd-scroll').scrollLeft;purchaseFocus=+yr;drawFamilyTimeline(host,d);host.querySelector('.pd-scroll').scrollLeft=scroll;};
  host.querySelector('select').onchange=e=>{select(e.target.value);host.querySelector('select').focus({preventScroll:true});};
  host.querySelector('svg').onclick=e=>{const yr=e.target.closest('[data-year]')?.dataset.year;if(yr)select(yr);};
}
