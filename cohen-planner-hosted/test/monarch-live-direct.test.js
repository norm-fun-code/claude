import {describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createMonarchLive}=require('../monarch-live');
const accounts=[{id:'a',displayName:'Checking',currentBalance:100,institution:{name:'Bank'},type:{name:'cash'},subtype:{name:'checking'}},{id:'b',displayName:'401k',currentBalance:200,institution:{name:'Fidelity'},type:{name:'investment'},subtype:{name:'401k'}}];
const db=()=>({query:vi.fn(async(sql,args)=>{if(sql.includes('SELECT data'))return {rows:[]};return {rows:[]}})});
describe('direct Monarch balances',()=>{
 it('uses the shared client and preserves a complete snapshot',async()=>{const client={query:vi.fn(async()=>({accounts}))};const live=createMonarchLive({db:db(),client,now:()=>Date.parse('2026-10-08T12:00:00Z')});const x=await live.getSnapshot(true);expect(client.query).toHaveBeenCalledWith('GetAccounts',expect.any(String));expect(x.source).toBe('monarch-direct');expect(x.accounts).toHaveLength(2);});
 it('keeps missing account balances unknown',async()=>{const client={query:vi.fn(async()=>({accounts:[...accounts,{id:'c',displayName:'Missing',currentBalance:null}]}))};const x=await createMonarchLive({db:db(),client,now:Date.now}).getSnapshot(true);expect(x.partial).toBe(true);expect(x.missingAccounts[0].id).toBe('c');});
 it('keeps the last good snapshot when Monarch fails',async()=>{const local={snapshot:{version:1,asOf:'2026-10-07T12:00:00Z',accounts}};const q=vi.fn(async(sql,args)=>{if(sql.includes('SELECT data'))return {rows:[{data:local}]};return {rows:[]}});const client={query:vi.fn(async()=>{throw new Error('Monarch unavailable')})};const x=await createMonarchLive({db:{query:q},client,now:()=>Date.parse('2026-10-08T12:00:00Z')}).getSnapshot(true);expect(x.accounts).toHaveLength(2);expect(x.warning).toMatch(/unavailable/);});
});
