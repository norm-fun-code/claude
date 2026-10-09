import {it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createMonarchSession}=require('../monarch-session');
const {createMonarchTransactions}=require('../monarch-transactions');
const env={MONARCH_TOKEN:'expired',MONARCH_EMAIL:'example@example.com',MONARCH_PASSWORD:'secret'};
function database(){let data;return {query:vi.fn(async(sql,args)=>{if(sql.startsWith('SELECT'))return {rows:data?[{data}]:[]};data=JSON.parse(args[1]);return {rows:[]}})}}
const ok=body=>({ok:true,status:200,json:async()=>body});
it('renews a rejected request once, retries it and preserves the session across restarts',async()=>{
 const db=database();const fetchImpl=vi.fn(async(url,opts)=>{
  if(url.endsWith('/auth/login/'))return ok({token:'renewed'});
  return opts.headers.Authorization==='Token renewed'?ok({data:{categories:[{id:'c',name:'Food'}]}}):{status:401,ok:false};
 });
 expect(await createMonarchTransactions({db,env,fetchImpl}).categories()).toHaveLength(1);
 expect(fetchImpl).toHaveBeenCalledTimes(3);
 const login=fetchImpl.mock.calls[1];expect(login[0]).toBe('https://api.monarch.com/auth/login/');
 expect(JSON.parse(login[1].body)).toMatchObject({username:env.MONARCH_EMAIL,password:env.MONARCH_PASSWORD,trusted_device:true});
 const restart=createMonarchSession({db,env:{...env,MONARCH_COOKIE:'sessionid=expired'},fetchImpl});
 expect((await restart.current()).headers.Authorization).toBe('Token renewed');expect((await restart.current()).headers.Cookie).toBeUndefined();
 expect(fetchImpl).toHaveBeenCalledTimes(3);
});
it('coalesces concurrent renewals into one login and reuses the trusted device',async()=>{
 const db=database();const fetchImpl=vi.fn(async()=>ok({token:'new'}));let time=1_000_000;
 const session=createMonarchSession({db,env,fetchImpl,now:()=>time});const old=await session.current();
 await Promise.all([session.renew(old.generation),session.renew(old.generation),session.renew(old.generation)]);
 expect(fetchImpl).toHaveBeenCalledTimes(1);await session.renew(old.generation);expect(fetchImpl).toHaveBeenCalledTimes(1);
 time+=300001;await session.renew((await session.current()).generation);expect(fetchImpl).toHaveBeenCalledTimes(2);
 expect(fetchImpl.mock.calls[0][1].headers['device-uuid']).toBe(fetchImpl.mock.calls[1][1].headers['device-uuid']);
});
it('does not retry failed verification repeatedly, persists the cooldown, or expose upstream secrets',async()=>{
 const db=database();const fetchImpl=vi.fn(async()=>({status:403,ok:false,json:async()=>({error_code:'email_otp_required',message:'secret'})}));
 const session=createMonarchSession({db,env,fetchImpl,now:()=>100});
 await expect(session.renew(0)).rejects.toThrow('account verification');
 const restart=createMonarchSession({db,env,fetchImpl,now:()=>101});await expect(restart.renew(0)).rejects.toThrow('account verification');expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('does not enter a login loop when the renewed session is also rejected',async()=>{
 const db=database();const fetchImpl=vi.fn(async(url)=>url.endsWith('/auth/login/')?ok({token:'bad'}):{status:401,ok:false});
 const api=createMonarchTransactions({db,env,fetchImpl});await expect(api.categories()).rejects.toThrow('renewed session');
 await expect(api.categories()).rejects.toThrow('five minutes');expect(fetchImpl.mock.calls.filter(([url])=>url.endsWith('/auth/login/'))).toHaveLength(1);
});
it('keeps an accepted session and never logs in for rate limits or permission failures',async()=>{
 for(const status of [403,429]){
  const fetchImpl=vi.fn(async()=>({status,ok:false}));const api=createMonarchTransactions({db:database(),env,fetchImpl});await expect(api.categories()).rejects.toThrow();expect(fetchImpl).toHaveBeenCalledTimes(1);
 }
});
