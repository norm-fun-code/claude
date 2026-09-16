const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const request=require('supertest');
const {createPlannerAccountsRouter}=require('../src/routes/planner-accounts');
const {mapHoldings,periodWindow,shapePortfolio}=require('../src/services/planner-holdings');
const position={ticker:'FXAIX',name:'Index',value:110,securityType:'mutual_fund',periodChange:10,periodChangePct:10,allTimeChange:30,allTimePct:37.5};
function fixture(){
 let clock=Date.parse('2026-09-16T12:00:00Z'),saved={},calls=0,fail=false;
 const db={query:async(sql,args)=>{if(sql.startsWith('SELECT'))return {rows:[{id:'monarch',config:{plannerHoldings:saved}}]};if(sql.startsWith('UPDATE'))saved[args[0]]=JSON.parse(args[1]);return {rows:[]};}};
 const api={getPlannerHoldings:async(token,window)=>{calls++;assert.equal(token,'upstream-secret');assert.ok(window.startDate);if(fail)throw {response:{status:429}};return [position];}};
 const app=express();app.use('/integrations/planner',createPlannerAccountsRouter({db,api,env:{PLANNER_BRIDGE_TOKEN:'bridge-secret',MONARCH_TOKEN:'upstream-secret'},now:()=>clock}));
 return {get:(period='1M',auth=true)=>{const r=request(app).get('/integrations/planner/holdings?period='+period);return auth?r.set('Authorization','Bearer bridge-secret'):r;},calls:()=>calls,advance:()=>{clock+=360000;fail=true;}};
}
test('rejects unauthorized and invalid periods before touching upstream',async()=>{const f=fixture();await f.get('1M',false).expect(401);await f.get('invalid').expect(400);assert.equal(f.calls(),0);});
test('caches each window and returns positions, not secrets',async()=>{const f=fixture();const r=await f.get().expect(200);assert.equal(r.body.holdings[0].ticker,'FXAIX');assert.equal(r.body.periodMetric,'current_holdings_growth');assert.equal(r.body.periodChange,10);assert.ok(!JSON.stringify(r.body).includes('secret'));await f.get().expect(200);assert.equal(f.calls(),1);await f.get('YTD').expect(200);assert.equal(f.calls(),2);});
test('upstream failure retains dated positions and backs off',async()=>{const f=fixture();const first=await f.get();f.advance();const r=await f.get().expect(200);assert.equal(r.body.asOf,first.body.asOf);assert.equal(r.body.stale,true);assert.match(r.body.warning,/rate-limiting/);await f.get().expect(200);assert.equal(f.calls(),2);});
test('YTD is anchored to January',()=>{assert.equal(periodWindow('YTD',Date.parse('2026-09-16')).startDate,'2026-01-01');});
test('price changes use position value; missing history remains unavailable',()=>{
 const h=mapHoldings({aggregateHoldings:{edges:[{node:{quantity:10,basis:80,totalValue:110,securityPriceChangePercent:10,securityPriceChangeDollars:1,security:{ticker:'ABC',type:'equity'}}}]}});
 assert.equal(h[0].periodChange,10);
 const partial=shapePortfolio([position,{...position,periodChange:null}],periodWindow('1M'));
 assert.equal(partial.periodChange,null);assert.equal(partial.periodChangePct,null);
});
