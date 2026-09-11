'use strict';
// ═══ UI PRIMITIVES ═══
// Pure presentation helpers shared by every screen. No DOM queries, no state — each
// function takes values and returns a string or a number, so they are testable and
// cannot drift between screens the way inline markup did.
//
// The formatting rules here exist because the app previously showed $1.63M, $127K,
// $16K, $23,500 and $500K on the same page. Five formats is no format: the reader has
// to re-calibrate at every figure instead of comparing them.

(function(root){

  // ── One money rule ───────────────────────────────────────────────────────
  // ≥ $1M  → two decimals of millions   ($1.63M)
  // ≥ $10K → whole thousands            ($127K)
  // else   → full dollars               ($4,500)
  // A missing value returns an em dash rather than "$0", because a zero someone can
  // read as a balance is worse than an obvious gap.
  function money(v,opts){
    const o=opts||{};
    // Number('') is 0 and Number(null) is 0, so an unset field would render as a
    // readable "$0" balance. An empty string is an absence, not a zero.
    if(v==null||v===''||!Number.isFinite(Number(v)))return o.missing||'—';
    const n=Number(v);
    const sign=n<0?'−':(o.signed&&n>0?'+':'');
    const a=Math.abs(n);
    let body;
    if(o.exact)body=a.toLocaleString('en-US',{maximumFractionDigits:0});
    else if(a>=1e6)body=(a/1e6).toFixed(2).replace(/\.00$/,'')+'M';
    else if(a>=1e4)body=Math.round(a/1e3)+'K';
    else body=Math.round(a).toLocaleString('en-US');
    return sign+'$'+body;
  }

  const pct=(v,dp)=>v==null||!Number.isFinite(Number(v))?'—':(Number(v)*100).toFixed(dp==null?1:dp)+'%';

  // ── Icons ────────────────────────────────────────────────────────────────
  // A closed set at currentColor. Adding one means adding it here, which is the point:
  // it stops a stray emoji appearing in a corner nobody reviewed.
  const PATHS={
    bell:'M6 7a4 4 0 0 1 8 0c0 4 1.5 5 1.5 5h-11S6 11 6 7Z M8.5 14.5a1.6 1.6 0 0 0 3 0',
    target:'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z M10 10h0',
    circle:'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z M10 8.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6Z',
    chart:'M4 16V9 M8 16V5 M12 16v-4 M16 16V7',
    card:'M3 6.5h14v8H3z M3 9.5h14',
    gear:'M10 7.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z M16.3 12a1.2 1.2 0 0 0 .24 1.32l.04.05a1.45 1.45 0 1 1-2.06 2.06l-.05-.05a1.2 1.2 0 0 0-1.32-.24 1.2 1.2 0 0 0-.73 1.1v.13a1.45 1.45 0 0 1-2.9 0v-.07a1.2 1.2 0 0 0-.78-1.1 1.2 1.2 0 0 0-1.32.24l-.05.05a1.45 1.45 0 1 1-2.06-2.06l.05-.05a1.2 1.2 0 0 0 .24-1.32 1.2 1.2 0 0 0-1.1-.73H4.3a1.45 1.45 0 1 1 0-2.9h.07a1.2 1.2 0 0 0 1.1-.78 1.2 1.2 0 0 0-.24-1.32l-.05-.05A1.45 1.45 0 1 1 7.25 4.2l.05.05a1.2 1.2 0 0 0 1.32.24h.06a1.2 1.2 0 0 0 .73-1.1V3.3a1.45 1.45 0 1 1 2.9 0v.07a1.2 1.2 0 0 0 .73 1.1 1.2 1.2 0 0 0 1.32-.24l.05-.05a1.45 1.45 0 1 1 2.06 2.06l-.05.05a1.2 1.2 0 0 0-.24 1.32v.06a1.2 1.2 0 0 0 1.1.73h.13a1.45 1.45 0 1 1 0 2.9h-.07a1.2 1.2 0 0 0-1.1.73Z',
    home:'M3.5 8.5 10 3.5l6.5 5 M5 7.8V16h10V7.8',
    diamond:'M10 3.2 16.8 10 10 16.8 3.2 10Z',
    arrow:'M4.5 15.5 15.5 4.5 M8 4.5h7.5V12',
    check:'M4.5 10.5 8 14l7.5-8',
    clock:'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z M10 6.2v4.1l2.7 1.6',
    alert:'M10 3.6 17.2 16H2.8L10 3.6Z M10 8.2v3.4 M10 13.6h0',
    doc:'M5.5 3.5h6L14.5 6.5v10h-9Z M11.2 3.6v3.2h3.2',
    spark:'M10 2.8l1.7 4.4 4.4 1.7-4.4 1.7L10 15l-1.7-4.4L3.9 8.9l4.4-1.7Z',
  };
  function icon(name,cls){
    const d=PATHS[name];
    if(!d)return'';
    return`<svg class="ui-icon${cls?' '+cls:''}" viewBox="0 0 20 20" aria-hidden="true">`+
      d.split(' M').map((seg,i)=>`<path d="${i?'M'+seg:seg}"/>`).join('')+'</svg>';
  }

  // ── Provenance ───────────────────────────────────────────────────────────
  // The chip that lets the number always be shown. A figure with no chip is a figure
  // whose origin nobody checked, so the default is the honest one.
  const PROV_LABEL={observed:'observed',projected:'projected',entered:'entered',missing:'unavailable'};
  function prov(kind,label){
    const k=PROV_LABEL[kind]?kind:'missing';
    return`<span class="ui-prov" data-prov="${k}">${escapeHtml(label||PROV_LABEL[k])}</span>`;
  }

  function escapeHtml(s){
    return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── The hero's fallback ──────────────────────────────────────────────────
  // The rule the old hero broke: never give the largest type on the page to a value
  // that can be absent. When accounts are unreachable the PLAN still knows a figure,
  // so show that and let the chip say where it came from. A dash in 82px type tells
  // the reader nothing except that the product is broken.
  function heroValue({observed,projected,complete}){
    const hasObserved=observed!=null&&Number.isFinite(Number(observed));
    if(hasObserved&&complete!==false)
      return{value:Number(observed),source:'observed',
        note:'Latest reported balances across your accounts.'};
    if(hasObserved)
      return{value:Number(observed),source:'observed',partial:true,
        note:'Some balances are missing, so this total is short by an unknown amount.'};
    if(projected!=null&&Number.isFinite(Number(projected)))
      return{value:Number(projected),source:'projected',
        note:'From your plan — account balances are unavailable right now.'};
    return{value:null,source:'missing',note:'No figure is available from accounts or the plan.'};
  }

  // ── Count-up ─────────────────────────────────────────────────────────────
  // The hero animates once on load. Everything else is still. Respects the OS setting,
  // and lands on the exact target rather than an eased approximation of it.
  function countUp(el,target,opts){
    if(!el)return;
    const o=opts||{};
    const format=o.format||(v=>money(v));
    const reduce=typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(target==null||!Number.isFinite(Number(target))||reduce||o.instant){
      el.textContent=format(target);return;
    }
    const to=Number(target),dur=o.duration||650,t0=(root.performance||Date).now();
    const ease=t=>1-Math.pow(1-t,3);
    (function step(){
      const t=Math.min(1,((root.performance||Date).now()-t0)/dur);
      el.textContent=format(to*ease(t));
      if(t<1)root.requestAnimationFrame(step);else el.textContent=format(to);
    })();
  }

  const api={money,pct,icon,prov,escapeHtml,heroValue,countUp,PATHS,PROV_LABEL};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.UI=api;
})(typeof window!=='undefined'?window:this);
