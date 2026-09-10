const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const request=require('supertest');
const {createPlannerAccountsRouter}=require('../src/routes/planner-accounts');
function setup({configured=true,status=200,saved=null}={}) {
 let calls=0, published=null;
 const db={query:async sql=>({rows:sql.startsWith('SELECT')?[{id:'monarch',config:{plannerAccounts:saved}}]:[]})};
 const api={getAccounts:async()=>{calls++;if(status!==200)throw {response:{status}};return [{id:'a',displayName:'Cash',currentBalance:100}];}};
 const app=express();app.use('/integrations/planner',createPlannerAccountsRouter({db,api,publish:async s=>{published=s;},env:configured?{PLANNER_BRIDGE_TOKEN:'read-only-secret',MONARCH_TOKEN:'private-monarch-token'}:{},now:()=>Date.parse('2026-09-09T12:00:00Z')}));
 return {app,calls:()=>calls,published:()=>published};
}
test('integration fails closed without a credential, and rejects wrong credentials before retrieval',async()=>{
 const a=setup({configured:false});await request(a.app).get('/integrations/planner/accounts').expect(503);assert.equal(a.calls(),0);
 const b=setup();await request(b.app).get('/integrations/planner/accounts').expect(401);await request(b.app).get('/integrations/planner/accounts').set('Authorization','Bearer incorrect').expect(401);assert.equal(b.calls(),0);
});
test('authorized read uses existing Monarch connection and never returns credentials',async()=>{
 const x=setup();const r=await request(x.app).get('/integrations/planner/accounts').set('Authorization','Bearer read-only-secret').expect(200);
 assert.equal(r.body.accounts.length,1);assert.equal(x.published().asOf,r.body.asOf);assert.ok(!JSON.stringify(r.body).includes('private-monarch-token'));assert.equal(r.headers['cache-control'],'no-store');
});
test('throttling retains dated snapshot and suppresses repeated upstream requests',async()=>{
 const saved={version:1,asOf:'2026-09-01T00:00:00Z',source:'normos-import',accounts:[{displayName:'Cash',currentBalance:100}]};
 const x=setup({status:429,saved});
 for(let i=0;i<2;i++){const r=await request(x.app).get('/integrations/planner/accounts').set('Authorization','Bearer read-only-secret').expect(200);assert.equal(r.body.asOf,saved.asOf);assert.equal(r.body.stale,true);assert.match(r.body.warning,/rate-limiting/);}
 assert.equal(x.calls(),1);assert.equal(x.published(),null);
});
test('expired token without a snapshot is unavailable, never a fabricated zero',async()=>{
 const x=setup({status:401});const r=await request(x.app).get('/integrations/planner/accounts').set('Authorization','Bearer read-only-secret').expect(503);assert.equal(r.body.accounts,undefined);assert.match(r.body.error,/expired/);
});
