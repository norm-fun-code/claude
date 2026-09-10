import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createMonarchLive } = require('../monarch-live');
const now = Date.parse('2026-09-09T12:00:00Z');
const snapshot = (asOf='2026-09-09T11:59:00Z') => ({ version:1, asOf, source:'normos-import', accounts:[{id:'1',displayName:'Checking',currentBalance:0},{id:'2',displayName:'401k',currentBalance:200}] });
function setup({ local={}, shared=snapshot(), token=null, response, missing=false, env={} }={}) {
  const db = { query:vi.fn(async (sql,args) => {
    if(sql.startsWith('SELECT data'))return {rows:[{data:local}]};
    if(sql.includes('FROM sources')) { if(missing)throw Object.assign(new Error('missing'),{code:'42P01'}); return {rows:[{snapshot:shared,token}]}; }
    if(sql.startsWith('INSERT'))Object.assign(local,JSON.parse(args[0]));
    return {rows:[]};
  }) };
  const fetchImpl=vi.fn(async()=>response||({ok:true,json:async()=>({data:{accounts:snapshot().accounts}})}));
  return { bridge:createMonarchLive({db,fetchImpl,env,now:()=>now}),db,fetchImpl,local };
}
describe('NormOS Monarch bridge',()=>{
  it('uses imported balances without credentials, retaining zeros',async()=>{
    const {bridge,fetchImpl}=setup();
    const data=await bridge.getSnapshot();expect(data.accounts[0].currentBalance).toBe(0);expect(data.asOf).toBe(snapshot().asOf);expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('reports stale data without advancing its timestamp',async()=>{
    const {bridge}=setup({shared:snapshot('2026-09-01T00:00:00Z')});
    expect(await bridge.getSnapshot()).toMatchObject({stale:true,asOf:'2026-09-01T00:00:00Z',bankUpdatedAt:null});
  });
  it('coalesces refreshes, caches valid data, and keeps credentials private',async()=>{
    const {bridge,fetchImpl,local}=setup({shared:null,token:'server-only'});
    const [a,b]=await Promise.all([bridge.getSnapshot(),bridge.getSnapshot()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);expect(a).toEqual(b);expect(local.snapshot.asOf).toBe(new Date(now).toISOString());
    expect(JSON.stringify(await bridge.status())).not.toContain('server-only');
    await bridge.getSnapshot();expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('retains last-good data and backs off on throttling',async()=>{
    const newer=snapshot('2026-09-09T10:00:00Z');
    const {bridge,fetchImpl}=setup({local:{snapshot:newer},shared:snapshot('2026-09-08T00:00:00Z'),token:'secret',response:{ok:false,status:429}});
    expect(await bridge.getSnapshot()).toMatchObject({asOf:newer.asOf,warning:expect.any(String)});
    await bridge.getSnapshot();expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([[],[{displayName:'Checking',currentBalance:null}]])('rejects incomplete upstream accounts',async(accounts)=>{
    const saved=snapshot('2026-09-08T00:00:00Z');
    const {bridge,local}=setup({local:{snapshot:saved},token:'secret',shared:null,response:{ok:true,json:async()=>({data:{accounts}})}});
    const data=await bridge.getSnapshot();expect(data.asOf).toBe(saved.asOf);expect(local.snapshot).toEqual(saved);expect(data.warning).toBeTruthy();
  });
  it('does not confuse legacy OAuth with a working connection',async()=>{
    const {bridge}=setup({shared:null,missing:true});expect((await bridge.status()).connected).toBe(false);
    await expect(bridge.getSnapshot()).rejects.toThrow('Waiting for');
  });
  it('honors pause without disabling NormOS itself',async()=>{
    const {bridge,fetchImpl}=setup({local:{disabled:true},token:'secret'});
    expect((await bridge.status()).connected).toBe(false);await expect(bridge.getSnapshot()).rejects.toThrow('paused');expect(fetchImpl).not.toHaveBeenCalled();
    await bridge.setEnabled(true);expect((await bridge.status()).connected).toBe(true);
  });
});

describe('authenticated NormOS account endpoint',()=>{
 const env={NORMOS_URL:'https://normos.example',PLANNER_BRIDGE_TOKEN:'dedicated-secret'};
 it('uses the remote source when databases differ and does not call Monarch separately',async()=>{
  const {bridge,fetchImpl}=setup({env,missing:true,shared:null,response:{ok:true,json:async()=>snapshot()}});
  const result=await bridge.getSnapshot();expect(result.source).toBe('normos-bridge');expect(result.accounts.length).toBe(2);
  expect(fetchImpl.mock.calls[0][0]).toBe('https://normos.example/integrations/planner/accounts');
  expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
  expect(JSON.stringify(await bridge.status())).not.toContain('dedicated-secret');
 });
 it('keeps local last-good data when the bridge rejects credentials',async()=>{
  const saved=snapshot('2026-09-01T00:00:00Z');
  const {bridge,fetchImpl}=setup({env,local:{snapshot:saved},missing:true,response:{ok:false,status:401}});
  expect(await bridge.getSnapshot()).toMatchObject({asOf:saved.asOf,stale:true,warning:expect.any(String)});
  await bridge.getSnapshot();expect(fetchImpl).toHaveBeenCalledTimes(1);
 });
 it('does not send the integration credential over an insecure URL',async()=>{
  const {bridge,fetchImpl}=setup({env:{...env,NORMOS_URL:'http://normos.example'},shared:null});
  await expect(bridge.getSnapshot()).rejects.toThrow('unavailable');expect(fetchImpl).not.toHaveBeenCalled();
 });
});
