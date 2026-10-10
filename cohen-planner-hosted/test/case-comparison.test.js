import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import Shared from '../public/shared-lines.js';
import Opening from '../public/opening.js';
import Grants from '../public/stripe-grants.js';
import Migration from '../public/plan-migrate.js';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=new Function('return ('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')')();
function harness(){
 const P={...D,masterBudget:true,normManualThroughYear:2037,stripeSimplified:true,observedOn:'2026-10-09',baseGroceries:19000};
 const strip=p=>Shared.strip(Grants.stripFacts(Opening.stripObserved(p)));
 const ctx={P,D,scenarioDirty:true,activeScenarioIdx:0,scenarios:[{params:strip(P)}],keepAssumptions:strip};
 ctx.scenarioPlan=p=>({...D,...Migration.migrateP(Shared.attach(Grants.withFacts(Opening.withObserved(p,P),P.stripeGrants),P)),normManualThroughYear:2037});
 vm.createContext(ctx);
 vm.runInContext(html.slice(html.indexOf('function caseReallyEdited()'),html.indexOf('function renderCaseControl()')),ctx);
 return {ctx,edited:()=>vm.runInContext('caseReallyEdited()',ctx)};
}
describe('saved case comparison with live shared settings',()=>{
 it('does not flag an unchanged case with a shared household budget on reopening',()=>{
  const h=harness();expect(h.edited()).toBe(false);expect(h.ctx.scenarioDirty).toBe(false);
 });
 it('does not turn account refreshes or shared budget updates into case edits',()=>{
  const h=harness();h.ctx.P.startingLiquid+=50000;h.ctx.P.observedOn='2026-10-10';h.ctx.P.baseGroceries+=4000;
  expect(h.edited()).toBe(false);
 });
 it('keeps genuine unsaved income and housing edits visible',()=>{
  for(const key of ['normCashY0','homePrice']){
   const h=harness();h.ctx.P[key]+=10000;expect(h.edited()).toBe(true);expect(h.ctx.scenarioDirty).toBe(true);
  }
 });
 it('clears the badge after a user reverses their edit',()=>{
  const h=harness(),cash=h.ctx.P.normCashY0;h.ctx.P.normCashY0+=10000;expect(h.edited()).toBe(true);
  h.ctx.P.normCashY0=cash;expect(h.edited()).toBe(false);
 });
});
