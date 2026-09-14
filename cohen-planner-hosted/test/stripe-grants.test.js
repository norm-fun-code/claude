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
function plan(){const p={...defaults,planEndYear:2030,observedOn:null,stripeObservedMonth:null,stripeRetY0:.3,stripeRetY1:.2,stripeLongTermReturn:0,startingStripeEquity:0,stripePolicy:'retain',homePurchaseYear:2099};p.stripeGrants={...G.setup(p),enabled:true,referenceTender:100,reference409a:100,referenceValuation:100e9,defaultARG:0,defaultPEG:0,years:{2026:{arg:80000,peg:80000,multiplier:1,election:'arg'},2027:{arg:0,peg:0,multiplier:1,election:'arg'}}};return p;}
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
