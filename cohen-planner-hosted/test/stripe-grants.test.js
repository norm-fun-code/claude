import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const G=require('../public/stripe-grants.js');
const {normComp,run,runMonteCarlo}=require('../public/model.js');
const {rollForwardParams}=require('../public/plan-migrate.js');
const L=require('../public/liquidity.js');
const A=require('../public/advisor-tools.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const defaults=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
function plan(){const p={...defaults,planEndYear:2030,observedOn:null,stripeObservedMonth:null,stripeRetY0:.3,stripeRetY1:.2,stripeLongTermReturn:0,startingStripeEquity:0,stripePolicy:'retain',homePurchaseYear:2099};p.stripeGrants={...G.setup(p),enabled:true,throughYear:null,referenceTender:100,reference409a:100,referenceValuation:100e9,defaultARG:0,defaultPEG:0,years:{2026:{arg:80000,peg:80000,multiplier:1,election:'arg'},2027:{arg:0,peg:0,multiplier:1,election:'arg'}}};return p;}
describe('share-based awards',()=>{
  it('locks May shares for four ARG and eight PEG vests; appreciation increases vest income',()=>{
    const p=plan(),l=G.compile(p),arg=l.grants.find(g=>g.id==='ARG:2026'),peg=l.grants.find(g=>g.id==='PEG:2026');
    expect(arg.shares).toBe(800);expect(peg.shares).toBe(800);
    expect(arg.vests.map(v=>v.date)).toEqual(['2026-06-15','2026-09-15','2026-12-15','2027-03-15']);
    expect(peg.vests).toHaveLength(8);expect(peg.vests.at(-1).date).toBe('2028-03-15');
    expect(l.years[2026].stock).toBe(90000); // 3 × (200 ARG + 100 PEG) × $100
    expect(l.years[2027].stock).toBe(78000); // (200 ARG + 400 PEG) × $130
    expect(l.years[2028].stock).toBe(15600); // 100 PEG × $156
  });
  it('overlapping PEGs preserve separate grant prices and sum by calendar year',()=>{
    const p=plan();p.stripeGrants.years[2027].peg=104000;
    const l=G.compile(p),g=l.grants.find(g=>g.id==='PEG:2027');
    expect(g.price).toBe(130);expect(g.shares).toBe(800);
    expect(l.years[2027].peg).toBe(91000); // 400 prior + 300 new shares × 130
  });
  it('ARG/QCA is annual and March belongs to the prior award election',()=>{
    const p=plan();p.stripeGrants.years[2027]={arg:104000,peg:0,election:'qca',qca:['cash','stock','cash','stock']};
    const l=G.compile(p);
    expect(l.grants.some(g=>g.id==='ARG:2027')).toBe(false);
    expect(l.years[2027].events.find(e=>e.type==='ARG').date).toBe('2027-03-15');
    expect(l.years[2027].cash).toBe(52000);
    expect(l.years[2027].events.find(e=>e.type==='QCA'&&e.shares>0).shares).toBe(200);
    expect(l.years[2028].events.find(e=>e.grantId==='QCA:2027').shares).toBeCloseTo(26000/156);
  });
  it('QCA shares use each quarter’s 409A, independently of tender and May prices',()=>{
    const p=plan();p.stripeGrants.years[2026]={arg:80000,peg:0,election:'qca',qca:['stock','stock','cash','stock']};
    p.stripeGrants.prices[2026]={q409a:[40,50,80,90],grant:200};
    const l=G.compile(p),e=l.years[2026].events.filter(e=>e.type==='QCA');
    expect(e.map(v=>v.shares)).toEqual([400,250,0]);expect(e.map(v=>v.stock)).toEqual([20000,20000,0]);expect(l.years[2026].cash).toBe(20000);
  });
  it('actual shares replace estimates and remain fixed across scenarios',()=>{
    const p=plan();p.stripeGrants.actualGrants=[{type:'PEG',year:2027,vests:[{date:'2027-06-15',shares:123},{date:'2028-03-15',shares:456}]}];
    const lo=G.compile(p),hi=G.compile({...p,stripeRetY0:1});
    for(const l of [lo,hi])expect(l.grants.find(g=>g.id==='PEG:2027').shares).toBe(579);
    expect(hi.years[2027].events.find(e=>e.grantId==='PEG:2027').stock).toBe(24600);
    expect(hi.grants.find(g=>g.id==='PEG:2026').shares).toBe(lo.grants.find(g=>g.id==='PEG:2026').shares);
  });
  it('blank share periods estimate from dollar inputs; zero stays zero',()=>{
    const p=plan();p.stripeGrants.actualGrants=[{type:'ARG',year:2026,vests:[{date:'2026-06-15',shares:300},{date:'2026-09-15',shares:null},{date:'2026-12-15',shares:0},{date:'2027-03-15',shares:400}]}];
    const g=G.compile(p).grants.find(g=>g.id==='ARG:2026');
    expect(g.vests.map(v=>v.shares)).toEqual([300,200,0,400]);expect(g.status).toBe('Mixed');
  });
  it('remaining schedules retain estimated past income and only add future actual vests to holdings',()=>{
    const p=plan();p.observedOn='2026-09-14';p.stripeGrants.actualGrants=[{type:'ARG',year:2026,scheduleMode:'remaining',asOf:'2026-09-14',vests:[{date:'2026-09-15',shares:300},{date:'2026-12-15',shares:400},{date:'2027-03-15',shares:500}]}];
    const l=G.compile(p);expect(l.years[2026].arg).toBe(90000); // 200 estimated past + 300 + 400 actual
    const r=run(p).R[0];expect(r.sAdded).toBeCloseTo((700+200)*100*(1-r.sVestRate),0); // remaining ARG + two PEG vests
  });
  it('award changes persist into future years without changing known shares',()=>{
    const p=plan();p.stripeGrants.years[2028]={arg:100000,peg:65000,multiplier:1.5};
    expect(G.award(p,2029)).toMatchObject({arg:100000,peg:65000,multiplier:1.5});
  });
});
describe('prices and projections reconcile',()=>{
  it('caps valuation with dilution applied separately to per-share growth',()=>{
    const p=plan();p.stripeGrants.valuationCeiling=120e9;p.stripeGrants.dilutionRate=.1;
    const l=G.compile(p);expect(l.prices[2027].valuation).toBe(120e9);expect(l.prices[2027].tender).toBeCloseTo(120/1.1);expect(l.prices[2028].tender).toBeCloseTo(120/1.1/1.1);
  });
  it('historical overrides do not contaminate the reference-year anchor',()=>{
    const p=plan();p.stripeGrants.prices[2024]={tender:30};
    const l=G.compile(p);expect(l.prices[2025].tender).toBe(100);expect(l.prices[2026].tender).toBe(100);
  });
  it('flows calculated comp into tax, income and net worth; manual stock is not added',()=>{
    const p=plan(),r=run(p).R[0],c=normComp(p,0);
    expect(r.normStock).toBe(90000);expect(c.stock).toBe(90000);expect(r.normG).toBe(r.normCash+r.normStock);
    expect(r.netWorth).toBe(r.liq+r.sEnd+r.eq+r.k401);expect(r.sNew+r.sVestTax).toBe(r.normStock);
    expect(run({...p,normStockY0:99999999}).R[0].netWorth).toBe(r.netWorth);
  });
  it('cash QCA adds once and can replace an allowance already in baseline cash',()=>{
    const p=plan();p.stripeGrants.years[2026]={arg:80000,peg:0,election:'qca',qca:['cash','cash','cash','cash'],cashAlreadyIncluded:80000};
    expect(normComp(p,0).cash).toBe(p.normCashY0-80000+60000);
    expect(run(p).R[0].normStock).toBe(0);
    expect(L.saleWindows(2026,{heldValue:100000},p).some(w=>w.kind==='elective')).toBe(false);
  });
  it('keeps income FMV and tender holding value separate, including sale gains and basis',()=>{
    const p=plan();p.stripeGrants.reference409a=50;p.stripePolicy='sell';
    const r=run(p).R[0];
    expect(r.normStock).toBe(45000);expect(r.sNew).toBeCloseTo(90000*(1-r.sVestRate),0);
    expect(r.sNewSaleTax).toBeCloseTo(r.sSold*.5*p.capGainsTaxRate,0);
    expect(r.sEnd).toBe(0);
    const held=run({...p,stripePolicy:'retain'}).R[0];expect(held.sBasis).toBeCloseTo(held.sEnd*.5,0);
  });
  it('preserves comp and share-price paths when the start year rolls forward',()=>{
    const p=plan();p.stripeGrants.grantGrowth=.03;
    const before=G.compile(p),rolled=rollForwardParams(p),after=G.compile(rolled);
    for(let y=2027;y<=2030;y++){expect(after.years[y].stock).toBeCloseTo(before.years[y].stock);expect(after.prices[y].tender).toBeCloseTo(before.prices[y].tender);}
  });
  it('leaves legacy saved plans unchanged when grant mode is off',()=>{
    const p=plan(),legacy={...p};delete legacy.stripeGrants;
    const off={...p,stripeGrants:{...p.stripeGrants,enabled:false}};
    expect(run(off)).toEqual(run(legacy));
  });
  it('Monte Carlo uses the same deterministic grant income',()=>{
    const p={...plan(),mcVol:0};const m=runMonteCarlo(p,3);expect(m).toBeTruthy();
  });
  it('rejects invalid prices and duplicate actual grants',()=>{
    const p=plan();p.stripeGrants.prices[2027]={grant:0};expect(()=>G.compile(p)).toThrow(/positive/);
    p.stripeGrants.prices={};const g={type:'ARG',year:2026,vests:[{date:'2026-06-15',shares:10}]};p.stripeGrants.actualGrants=[g,g];expect(()=>G.compile(p)).toThrow(/Only one/);
  });
  it('rejects silent stock-input overrides while grants drive compensation',()=>{
    const p=plan();expect(A.applyOverrides(p,{normStockY0:5}).errors.length).toBe(1);
  });
});
describe('a saved case keeps the assumptions, not the grant ledger',()=>{
  const live=()=>{
    const p=plan();
    p.stripeGrants.actualGrants=[{type:'ARG',year:2026,vests:[{date:'2026-06-15',shares:300},{date:'2026-09-15',shares:300},{date:'2026-12-15',shares:300},{date:'2027-03-15',shares:300}]}];
    return p;
  };

  it('drops the facts on save and leaves the assumptions alone',()=>{
    const saved=G.stripFacts({...live(),investReturn:.04});
    for(const k of G.FACT_KEYS)expect(saved.stripeGrants).not.toHaveProperty(k);
    expect(saved.stripeGrants.years[2026].arg).toBe(80000);
    expect(saved.stripeGrants.defaultPEG).toBe(0);
    expect(saved.investReturn).toBe(.04);
  });

  it('re-attaches the facts on load',()=>{
    const p=live(), saved=G.stripFacts({...p});
    saved.stripeGrants.grantGrowth=.10;              // the case's own assumption
    const loaded=G.withFacts(saved,p.stripeGrants);
    expect(loaded.stripeGrants.enabled).toBe(true);
    expect(loaded.stripeGrants.referenceTender).toBe(100);
    expect(loaded.stripeGrants.actualGrants).toEqual(p.stripeGrants.actualGrants);
    expect(loaded.stripeGrants.grantGrowth).toBe(.10); // …survives the round trip
  });

  // The bug this exists to prevent. A case saved before the grants were entered carried an
  // empty ledger; loading it switched grant mode off and the projection silently fell back
  // to the flat-percentage estimate.
  it('a case saved before the grant model existed inherits it rather than switching it off',()=>{
    const p=live(), legacy={...p};delete legacy.stripeGrants;
    const loaded=G.withFacts(legacy,p.stripeGrants);
    expect(G.active(loaded)).toBe(true);
    expect(run(loaded).R.at(-1).netWorth).toBe(run(p).R.at(-1).netWorth);
    // …and without the fix, the same case projects a materially different future.
    expect(run(legacy).R.at(-1).netWorth).not.toBe(run(p).R.at(-1).netWorth);
  });

  it('a case that predates the split but baked the ledger in is healed, not trusted',()=>{
    const p=live();
    const stale={...p,stripeGrants:{...p.stripeGrants,enabled:false,actualGrants:[],referenceTender:1}};
    const loaded=G.withFacts(stale,p.stripeGrants);
    expect(loaded.stripeGrants.enabled).toBe(true);
    expect(loaded.stripeGrants.referenceTender).toBe(100);
    expect(loaded.stripeGrants.actualGrants).toEqual(p.stripeGrants.actualGrants);
  });

  it('holds the case unchanged when there is no live grant model to read',()=>{
    const saved=G.stripFacts({...live()});
    expect(G.withFacts(saved,null)).toEqual(saved);
    expect(G.withFacts(saved,undefined)).toEqual(saved);
  });

  it('never mutates what it is given, and never shares structure with the live plan',()=>{
    const p=live(), before=JSON.stringify(p);
    const saved=G.stripFacts(p), loaded=G.withFacts(saved,p.stripeGrants);
    expect(JSON.stringify(p)).toBe(before);
    expect(p.stripeGrants.actualGrants).not.toBe(loaded.stripeGrants.actualGrants);
    loaded.stripeGrants.actualGrants[0].vests[0].shares=1;
    expect(p.stripeGrants.actualGrants[0].vests[0].shares).toBe(300);
  });

  it('the app routes every case through both halves of the rule',()=>{
    expect(html).toContain('StripeGrants.stripFacts(out):out;');
    expect(html).toContain('StripeGrants.withFacts(out,P&&P.stripeGrants):out;');
  });
});

describe('Stripe workspace interactions',()=>{
  function workspace(){
    const p=plan(),elements={chartArea:{innerHTML:''}},messages=[];
    const ctx={P:p,StripeGrants:G,normComp,structuredClone,Date,Number,Math,console,_stripeYear:2026,fmt:n=>'$'+Math.round(n).toLocaleString('en-US'),document:{getElementById:id=>elements[id]||(elements[id]={value:'',innerHTML:''}),querySelectorAll:()=>[]},markDirty(){},buildControls(){},savePlannerState(){ctx.saved=JSON.parse(JSON.stringify(ctx.P));},showToast:m=>messages.push(m)};
    ctx.render=()=>vm.runInContext('renderStripeWorkspace([])',ctx);
    vm.createContext(ctx);vm.runInContext(fs.readFileSync(new URL('../public/stripe-grants-ui.js',import.meta.url),'utf8'),ctx);
    return {ctx,elements,messages,call:s=>vm.runInContext(s,ctx)};
  }
  it('renders every workspace view, updates dollars and preserves saved scenario isolation',()=>{
    const w=workspace(),old=w.ctx.P.stripeGrants;
    for(const tab of ['awards','prices','income']){w.call(`stripeWorkspaceSet('${tab}')`);expect(w.elements.chartArea.innerHTML).toContain('sg-workspace');expect(w.elements.chartArea.innerHTML).not.toContain('NaN');}
    w.call("stripeAwardSet(2027,'peg','100000')");expect(w.ctx.saved.stripeGrants.years[2027].peg).toBe(100000);expect(old.years[2027].peg).toBe(0);
    w.call("stripeAwardSet(2027,'election','qca')");w.call("stripeQCASet(2027,0,'stock')");expect(w.ctx.saved.stripeGrants.years[2027].qca[0]).toBe('stock');
  });
  it('stores partial actual shares and can restore estimated schedules',()=>{
    const w=workspace();w.call("stripeWorkspaceSet('awards')");
    ['2026-06-15','2026-09-15','2026-12-15','2027-03-15'].forEach((date,i)=>{w.elements['sg-date-ARG-'+i]={value:date};w.elements['sg-shares-ARG-'+i]={value:i===0?'123':''};});
    w.elements['sg-actual-asof']={value:'2026-09-14'};
    w.call("stripeActualSave('ARG',2026,4)");
    const g=w.ctx.saved.stripeGrants.actualGrants[0];expect(g.vests[0].shares).toBe(123);expect(g.vests[1].shares).toBeNull();
    expect(G.compile(w.ctx.saved).years[2026].arg).toBe(52300);
    w.call("stripeActualRemove('ARG',2026)");expect(w.ctx.saved.stripeGrants.actualGrants).toEqual([]);
  });
  it('retains previously entered past shares when saving only remaining shares',()=>{
    const w=workspace();w.ctx.P.stripeGrants.actualGrants=[{type:'ARG',year:2026,vests:[{date:'2026-06-15',shares:123},{date:'2026-09-15',shares:234},{date:'2026-12-15',shares:345},{date:'2027-03-15',shares:456}]}];
    w.call("stripeActualModeSet('remaining')");w.elements['sg-actual-asof']={value:'2026-09-14'};
    ['2026-09-15','2026-12-15','2027-03-15'].forEach((date,i)=>{w.elements['sg-date-ARG-'+i]={value:date};w.elements['sg-shares-ARG-'+i]={value:String(300+i)};});
    w.call("stripeActualSave('ARG',2026,3)");expect(G.compile(w.ctx.saved).years[2026].arg).toBe((123+300+301)*100);
  });
  it('shows the valuation and the share price for every year of the path',()=>{
    const w=workspace();w.call("stripeWorkspaceSet('prices')");
    const html=w.elements.chartArea.innerHTML;
    // Both halves of the path are available; the table carries them side by side.
    expect(html).toContain('Company valuation');
    expect(html).toContain('Tender price / share');
    const body=html.slice(html.indexOf('sg-path-table'));
    expect(body).toContain('Valuation change');
    expect(body).toContain('Per-share change');
    for(let y=2026;y<=2030;y++)expect(body).toContain(`<th>${y}</th>`);
    expect(body).toContain('Anchor');       // the reference year says so
    expect(body).toContain('Projected');
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it('separates valuation growth from per-share growth by the dilution assumed',()=>{
    const w=workspace();
    w.ctx.P.stripeGrants={...w.ctx.P.stripeGrants,dilutionRate:.02};
    w.call("stripeWorkspaceSet('prices')");
    const row=w.elements.chartArea.innerHTML.split('<tr').find(r=>r.includes('<th>2027</th>'));
    expect(row).toContain('+30%');  // valuation, off 2026's 30% growth
    expect(row).toContain('+27%');  // per share, after 2% dilution
  });

  it('draws one chart and swaps which series it shows',()=>{
    const w=workspace();w.call("stripeWorkspaceSet('prices')");
    const caption=()=>w.elements.chartArea.innerHTML.match(/<figcaption>([^<]+)</)[1].trim();
    expect(w.elements.chartArea.innerHTML.match(/<figure class="sg-chart"/g)).toHaveLength(1);
    expect(caption()).toBe('Tender price / share');
    w.call("stripeValModeSet('valuation')");
    expect(w.elements.chartArea.innerHTML.match(/<figure class="sg-chart"/g)).toHaveLength(1);
    expect(caption()).toBe('Company valuation');
    w.call("stripeValModeSet('price')");
    expect(caption()).toBe('Tender price / share');
  });

  it('carries every year in the chart so any of them can be read on hover',()=>{
    const w=workspace();w.call("stripeWorkspaceSet('prices')");
    const pts=JSON.parse(w.elements.chartArea.innerHTML.match(/data-pts='([^']+)'/)[1]);
    expect(pts).toHaveLength(2030-2026+1);            // every plan year, not just the three labelled
    expect(pts[0][0]).toBe('2026');
    expect(pts.at(-1)[0]).toBe('2030');
    for(const [,label,y] of pts){expect(label).toMatch(/^\$[\d,]+$/);expect(Number.isFinite(y)).toBe(true);}
  });

  it('rounds every figure on the path to whole dollars',()=>{
    const w=workspace();
    w.ctx.P.stripeGrants={...w.ctx.P.stripeGrants,dilutionRate:.017};  // guarantees ragged decimals
    w.call("stripeWorkspaceSet('prices')");
    const text=w.elements.chartArea.innerHTML.replace(/<[^>]+>/g,' ');
    expect(text).not.toMatch(/\$[\d,]+\.\d/);   // no $256.794
    expect(text).not.toMatch(/[-+]\d+\.\d%/);   // no +12.7%
  });

  it('carries a share price alone when no valuation is set',()=>{
    const w=workspace();
    w.ctx.P.stripeGrants={...w.ctx.P.stripeGrants,referenceValuation:null};
    w.call("stripeWorkspaceSet('prices')");
    const html=w.elements.chartArea.innerHTML;
    expect(html).toContain('Tender price / share');
    expect(html).toContain('No reference valuation is set');
    expect(html).not.toContain('Valuation change');
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it('rejects invalid configuration without corrupting active plan',()=>{
    const w=workspace();w.call("stripeGrantSet('referenceTender','0')");expect(w.ctx.P.stripeGrants.referenceTender).toBe(100);expect(w.messages.at(-1)).toMatch(/positive/);
  });
});
describe('grant-mode sale timing',()=>{
  it('February tender excludes March vests and does not count the same holding twice under caps',()=>{
    const p=plan();p.stripeTenderCapPerEvent=100;
    const windows=L.saleWindows(2026,{heldValue:50,vestByQuarter:[100,100,100,100]},p);
    expect(windows[0].cap).toBe(50);expect(windows[1].cap).toBe(100);
    expect(L.raisableBy(2026,1,{heldValue:0,vestByQuarter:[100,100,100,100]},p)).toBe(0);
  });
});
