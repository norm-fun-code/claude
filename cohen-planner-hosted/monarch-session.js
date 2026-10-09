'use strict';
const {randomUUID}=require('node:crypto');
const KEY='monarch_direct_session';
const LOGIN='https://api.monarch.com/auth/login/';
const COOLDOWN=5*60*1000;
// Server-only session. No credentials or upstream response bodies reach logs/API output.
function createMonarchSession({db,env=process.env,fetchImpl=fetch,now=Date.now}={}) {
  let state,loading,renewing,generation=0;
  async function load() {
    if(state)return state;
    if(!loading)loading=(async()=>{
      const rows=db?(await db.query('SELECT data FROM oauth_tokens WHERE key = $1',[KEY])).rows:[];
      state=rows[0]?.data||{}; return state;
    })().finally(()=>{loading=null});
    return loading;
  }
  async function save(next) {
    if(db)await db.query('INSERT INTO oauth_tokens (key,data) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data',[KEY,JSON.stringify(next)]);
    state=next;
  }
  async function current() {
    const s=await load();
    const cookie=s.cookie||(s.token?null:env.MONARCH_COOKIE);
    const token=s.token||env.MONARCH_TOKEN;
    const headers={'Content-Type':'application/json','Client-Platform':'web'};
    if(cookie) {
      headers.Cookie=cookie.trim();
      const csrf=cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
      if(csrf)headers['X-CSRFToken']=csrf;
      headers.Origin='https://app.monarch.com';headers.Referer='https://app.monarch.com/';
    } else if(token)headers.Authorization='Token '+token.trim();
    else if(env.MONARCH_EMAIL&&env.MONARCH_PASSWORD) {
      await renew(generation);return current();
    } else throw new Error('Direct Monarch import is not configured. Set MONARCH_TOKEN or MONARCH_COOKIE on the planner service.');
    return {headers,generation};
  }
  async function renew(rejectedGeneration) {
    await load();
    if(rejectedGeneration!==generation)return;
    if(renewing)return renewing;
    if(!env.MONARCH_EMAIL||!env.MONARCH_PASSWORD)throw new Error('Monarch session expired; automatic renewal needs the planner’s saved Monarch login.');
    if(state.lastAttempt!=null&&now()-state.lastAttempt<COOLDOWN)throw new Error('Monarch automatic renewal is waiting after a recent attempt. Saved transactions were kept; retry in five minutes.');
    renewing=(async()=>{
      const deviceUuid=state.deviceUuid||randomUUID();
      await save({...state,deviceUuid,lastAttempt:now()});
      let response;
      try {
        response=await fetchImpl(LOGIN,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','Client-Platform':'web','device-uuid':deviceUuid,Origin:'https://app.monarch.com'},
          body:JSON.stringify({username:env.MONARCH_EMAIL,password:env.MONARCH_PASSWORD,trusted_device:true,supports_mfa:true,supports_email_otp:true}),
          cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
      } catch {throw new Error('Monarch automatic renewal could not reach Monarch. Saved transactions were kept.');}
      if(response.status===429)throw new Error('Monarch rate-limited automatic renewal. Saved transactions were kept; retry later.');
      const body=await response.json().catch(()=>null);
      if(!response.ok||!body?.token) {
        const verification=body?.mfa_required||body?.email_otp_required||/mfa|otp|verification|two.factor/i.test(String(body?.error_code||''));
        throw new Error(verification?'Monarch requires account verification before automatic renewal can continue. Saved transactions were kept.':'Monarch rejected automatic session renewal. Account verification or a corrected saved login may be needed. Saved transactions were kept.');
      }
      if(typeof body.token!=='string'||!body.token.trim())throw new Error('Monarch renewal returned no usable session.');
      // Persist before exposing the session; it survives deploys and process restarts.
      await save({token:body.token,deviceUuid,renewedAt:now(),lastAttempt:now()});generation++;
    })().finally(()=>{renewing=null});
    return renewing;
  }
  return {current,renew};
}
module.exports={createMonarchSession};
