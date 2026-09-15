import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url),G=require('../public/stripe-grants.js'),M=require('../public/model.js'),PM=require('../public/plan-migrate.js'),L=require('../public/liquidity.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=new Function('return ('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')')();
function plan(){const p={...D,observedOn:null,homePurchaseYear:2099,stripePolicy:'retain'};p.stripeGrants={...G.setup(p),enabled:true,throughYear:null,referenceTender:100,reference409a:80,referenceValuation:160e9};return p;}
describe('simplified Stripe',()=>{
 it('preserves effective cash and stock for all years including hybrid overrides; migration is idempotent',()=>{
  const p=G.prefillManual(plan(),2027);p.stripeGrants.manualComp[2029]={cash:350000,stock:0};const before=JSON.stringify(p),s=PM.migrateP(p);
  for(let y=2026;y<=2058;y++){const old=M.normComp(p,y-2026),n=M.normComp(s,y-2026);expect(n.cash).toBe(old.cash);expect(n.stock).toBe(old.stock);}
  expect(s.stripeGrants.enabled).toBe(false);expect(s.stripeGrants.actualGrants).toEqual(p.stripeGrants.actualGrants);expect(PM.migrateP(s)).toEqual(s);expect(JSON.stringify(p)).toBe(before);
 });
 it('income is independent of price growth, new stock is added once, and February marks the opening balance',()=>{
  const p=PM.migrateP(plan()),q=structuredClone(p);q.stripeRetY0=.8;
  expect(M.normComp(q,1)).toEqual(M.normComp(p,1));
  const a=M.run(p).R,b=M.run(q).R;
  expect(a[0].sEnd).toBeCloseTo(b[0].sEnd,6);expect(b[1].sEnd).toBeGreaterThan(a[1].sEnd);
  let prior=p.startingStripeEquity||0;for(const r of a){expect(Math.abs(r.sNew-(r.normStock-r.sVestTax))).toBeLessThanOrEqual(1);expect(Math.abs(r.sEnd-(prior+r.sAppr+r.sAdded-r.sHold))).toBeLessThanOrEqual(2);prior=r.sEnd;}
 });
 it('valuation ceiling controls the actual holdings path too',()=>{
  const p=PM.migrateP(plan());p.stripeGrants.valuationCeiling=160e9;const rows=M.run(p).R;
  expect(rows[1].sMarked).toBe(0);expect(G.pricePath(p,2026,2027)[2027].valuation).toBe(160e9);
 });
 it('converts old saved cases using their own assumptions and shared live award facts',()=>{
  const p=plan(),saved=G.stripFacts(p);saved.stripeGrants.defaultPEG=100000;
  const expected=G.withFacts(saved,p.stripeGrants),live=PM.migrateP(p);
  const actual=PM.migrateP(G.withFacts(saved,live.stripeGrants));
  expect(M.normComp(actual,2).stock).toBe(M.normComp(expected,2).stock);
 });
 it('roll-forward keeps manual calendar-year compensation and the valuation anchor',()=>{
  const p=PM.migrateP(plan()),q=PM.rollForwardParams(p);
  for(let i=0;i<20;i++)expect(M.normComp(q,i)).toEqual(M.normComp(p,i+1));
  expect(q.stripeGrants.referenceValuation).toBe(G.pricePath(p,2026,2027)[2027].valuation);
 });
 it('never offers arbitrary QCA sales or March vests in February',()=>{
  const p=PM.migrateP(plan()),windows=L.saleWindows(2026,{heldValue:0,vestPerQuarter:100},p);
  expect(windows.some(w=>w.kind==='elective')).toBe(false);expect(windows[0].cap).toBe(0);
 });
});
function workspace(){
 const elements={chartArea:{innerHTML:''}},messages=[],p=PM.migrateP(plan());
 const ctx={P:p,StripeGrants:G,normComp:M.normComp,structuredClone,scenarios:[{name:'Conservative',params:{...p,stripeRetY0:.1}}],scenarioPlan:p=>p,fmt:n=>'$'+Math.round(n),document:{getElementById:id=>elements[id]},markDirty(){},buildControls(){},savePlannerState(){},showToast:m=>messages.push(m)};
 ctx.render=()=>vm.runInContext('renderStripeWorkspace([])',ctx);vm.createContext(ctx);vm.runInContext(fs.readFileSync(new URL('../public/stripe-grants-ui.js',import.meta.url),'utf8'),ctx);
 return {ctx,elements,messages,call:s=>vm.runInContext(s,ctx)};
}
describe('simple Stripe UI',()=>{
 it('renders compensation and valuation with no award controls and a readable scenario table',()=>{
  const w=workspace();for(const t of ['income','prices']){w.call(`stripeWorkspaceSet('${t}')`);expect(w.elements.chartArea.innerHTML).not.toMatch(/NaN|undefined|Awards & elections|Use grant model through/);}
  expect(w.elements.chartArea.innerHTML).toContain('Conservative');expect(w.elements.chartArea.innerHTML).toContain('$176B');
  const pts=JSON.parse(w.elements.chartArea.innerHTML.match(/data-pts='([^']+)'/)[1]);expect(pts).toHaveLength(33);
 });
 it('edits the same first-eleven-year inputs and isolates later overrides',()=>{
  const w=workspace();w.call("stripeWorkspaceSet('income')");w.call("stripeManualSet(2026,'stock','123000')");expect(M.normComp(w.ctx.P,0).stock).toBe(123000);
  const old=w.ctx.P.stripeManualLater;w.call("stripeManualSet(2040,'cash','0')");expect(M.normComp(w.ctx.P,14).cash).toBe(0);expect(old[2040].cash).toBeGreaterThan(0);
  w.call("stripeManualSet(2026,'stock','-1')");expect(M.normComp(w.ctx.P,0).stock).toBe(123000);expect(w.messages.length).toBe(1);
 });
 it('takes the valuation in billions, the unit anyone actually writes it in',()=>{
  const w=workspace();w.call("stripeWorkspaceSet('prices')");
  w.call("stripeGrantSet('referenceValuation','160')");
  expect(w.ctx.P.stripeGrants.referenceValuation).toBe(160e9);   // stored in dollars
  const html=w.elements.chartArea.innerHTML;
  expect(html).toContain('Reference valuation ($B)');
  expect(html).toContain('id="sg-grant-referenceValuation" type="number" min="0" step="any" value="160"');
  expect(html).toContain('$160B');       // and nothing rounds it to $0B
  expect(html).not.toContain('$0B');
  w.call("stripeGrantSet('valuationCeiling','400')");
  expect(w.ctx.P.stripeGrants.valuationCeiling).toBe(400e9);
 });

 it('reads a figure saved under the old dollars label in the unit it can only have meant',()=>{
  // $160 is not a company valuation; $106.5B is. Only the first can be a units mistake.
  const healed=PM.migrateP({stripeSimplified:true,stripeGrants:{referenceValuation:160,valuationCeiling:400}});
  expect(healed.stripeGrants.referenceValuation).toBe(160e9);
  expect(healed.stripeGrants.valuationCeiling).toBe(400e9);
  const real={stripeSimplified:true,stripeGrants:{referenceValuation:106.5e9,valuationCeiling:null}};
  expect(PM.migrateP(real).stripeGrants.referenceValuation).toBe(106.5e9);
  expect(PM.migrateP(real).stripeGrants.valuationCeiling).toBeNull();
  expect(PM.migrateP(PM.migrateP(healed))).toEqual(PM.migrateP(healed));   // idempotent
 });

 it('edits a compensation cell without rebuilding the table under the cursor',()=>{
  // The table scrolls and is thirty-three rows deep. Re-rendering it on every blur sent it
  // back to the top and dropped the focus Tab had just moved on, which made working down a
  // column impossible. Totals update in place instead.
  const src=fs.readFileSync(new URL('../public/stripe-grants-ui.js',import.meta.url),'utf8');
  const body=src.slice(src.indexOf('function stripeManualSet'),src.indexOf('function stripeRefreshComp'))
    .split('\n').filter(l=>!l.trim().startsWith('//')).join('\n');
  expect(body).not.toMatch(/[^a-zA-Z]render\(\)/);
  expect(body).toContain('stripeRefreshComp()');

  const w=workspace();w.call("stripeWorkspaceSet('income')");
  for(const y of [2032,2040])for(const k of ['cash','stock'])w.elements[`sg-comp-${k}-${y}`]={value:'',tagName:'INPUT'};
  for(const y of [2032,2040])w.elements['sg-total-'+y]={textContent:''};
  w.call("stripeManualSet(2032,'cash','333333')");
  expect(w.elements['sg-comp-cash-2032'].value).toBe(333333);
  expect(w.elements['sg-total-2032'].textContent).toBe('$'+Math.round(333333+M.normComp(w.ctx.P,6).stock));
  // A year that later years are derived from moves them too, so every row refreshes.
  w.ctx.P.stripeManualLater={};   // 2040 now grows off 2036 rather than carrying its own figure
  w.call("stripeManualSet(2036,'cash','"+Math.round(M.normComp(w.ctx.P,10).cash)+"')");
  const before=w.elements['sg-total-2040'].textContent;
  w.call("stripeManualSet(2036,'cash','900000')");
  expect(w.elements['sg-total-2040'].textContent).not.toBe(before);
 });

 it('has an explicit empty state and no fabricated valuation',()=>{
  const w=workspace();w.ctx.P.stripeGrants.referenceValuation=null;w.call("stripeWorkspaceSet('prices')");expect(w.elements.chartArea.innerHTML).toContain('Enter a reference company valuation');expect(w.elements.chartArea.innerHTML).not.toContain('<figure');
 });
});
