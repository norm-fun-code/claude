'use strict';
// Monarch's official MCP server, as the planner's source of financial data.
//
// One browser sign-in grants the planner read access (scope mcp:read). After that the server refreshes
// its own access token, so it never holds the Monarch password. The flow is standard MCP OAuth: dynamic
// client registration, authorization code with PKCE, RFC 8707 resource indicator, rotating refresh tokens.
//
// Tool arguments are built from each tool's own input schema at run time rather than hard-coded, so a
// renamed date or paging argument does not silently drop a filter. Nothing here invents data: a result
// that cannot be read is an error, and the caller keeps what it saved last.
const crypto=require('node:crypto');
const AUTH='https://api.monarch.com';
const MCP='https://api.monarch.com/mcp';
const KEY='monarch_mcp';
const SCOPE='mcp:read';
const PROTOCOL='2025-06-18';

function parseSSEorJSON(text){
  const t=String(text||'').trimStart();
  if(t.startsWith('{')||t.startsWith('['))return JSON.parse(t);
  let out=null;
  for(const line of String(text||'').split('\n')){
    const l=line.trim();if(!l.startsWith('data:'))continue;
    const p=l.slice(5).trim();if(!p||p==='[DONE]')continue;
    try{const j=JSON.parse(p);if(j&&(j.result!==undefined||j.error!==undefined))out=j;}catch{/* not JSON */}
  }
  if(!out)throw new Error('Monarch returned an unreadable MCP response.');
  return out;
}

// A tool result is JSON in structuredContent, or JSON inside a text block. Either way, one value.
function toolPayload(result){
  if(!result)throw new Error('Monarch returned an empty MCP result.');
  if(result.isError){
    const msg=(result.content||[]).find(b=>b.type==='text')?.text||'';
    // Upstream text is not echoed: it can carry account details. Only its shape is reported.
    throw new Error('Monarch could not complete the request'+(/rate|limit|429/i.test(msg)?' (rate limited)':'')+'.');
  }
  if(result.structuredContent!=null)return result.structuredContent;
  const texts=(result.content||[]).filter(b=>b.type==='text').map(b=>b.text);
  for(const t of texts){try{return JSON.parse(t);}catch{/* try the next block */}}
  throw new Error('Monarch returned a result the planner cannot read.');
}

function createMonarchMcp({db,fetchImpl=fetch,now=Date.now}={}){
  let refreshing=null,sessionId=null,initialized=null,toolsCache=null;
  async function load(){return (await db.query('SELECT data FROM oauth_tokens WHERE key = $1',[KEY])).rows[0]?.data||null;}
  async function save(data){
    await db.query('INSERT INTO oauth_tokens (key,data) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data',[KEY,JSON.stringify(data)]);
    return data;
  }
  const form=o=>new URLSearchParams(Object.entries(o).filter(([,v])=>v!=null));

  // ── Sign-in ────────────────────────────────────────────────────────────
  async function startConnect(redirectUri){
    const stored=await load()||{};
    let clientId=stored.client_id&&stored.redirect_uri===redirectUri?stored.client_id:null;
    if(!clientId){
      const r=await fetchImpl(AUTH+'/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({client_name:'Cohen Financial Planner',redirect_uris:[redirectUri],grant_types:['authorization_code','refresh_token'],
          response_types:['code'],token_endpoint_auth_method:'none',scope:SCOPE}),signal:AbortSignal.timeout(15000)});
      if(!r.ok)throw new Error('Monarch would not register the planner (HTTP '+r.status+').');
      clientId=(await r.json()).client_id;
      if(!clientId)throw new Error('Monarch registered the planner without a client id.');
      // A new registration invalidates any grant made to an old client id.
      await save({client_id:clientId,redirect_uri:redirectUri});
    }
    const verifier=crypto.randomBytes(32).toString('base64url');
    const state=crypto.randomBytes(16).toString('hex');
    const url=new URL(AUTH+'/oauth/authorize/');
    for(const [k,v] of Object.entries({response_type:'code',client_id:clientId,redirect_uri:redirectUri,scope:SCOPE,
      code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',state,resource:MCP}))
      url.searchParams.set(k,v);
    return {url:url.toString(),pending:{verifier,state,clientId,redirectUri}};
  }
  async function finishConnect({code,state},pending){
    if(!pending||!state||state!==pending.state)throw new Error('The Monarch sign-in did not match this browser session. Start again.');
    if(!code)throw new Error('Monarch did not return a sign-in code.');
    const r=await fetchImpl(AUTH+'/oauth/token/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:form({grant_type:'authorization_code',code,redirect_uri:pending.redirectUri,client_id:pending.clientId,code_verifier:pending.verifier,resource:MCP}),
      signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error('Monarch refused the sign-in code (HTTP '+r.status+').');
    const t=await r.json();
    if(!t.access_token)throw new Error('Monarch returned no access token.');
    sessionId=null;initialized=null;toolsCache=null;
    await save({client_id:pending.clientId,redirect_uri:pending.redirectUri,access_token:t.access_token,refresh_token:t.refresh_token||null,
      expires_at:now()+(Number(t.expires_in)||3600)*1000,connectedAt:new Date(now()).toISOString(),needsReconnect:false,lastError:null});
    return {connected:true};
  }

  // ── Tokens ─────────────────────────────────────────────────────────────
  // One refresh at a time. Monarch rotates refresh tokens, so two concurrent refreshes would spend the
  // same one twice and the loser would revoke the winner's grant.
  async function accessToken(force=false){
    const s=await load();
    if(!s?.access_token)return null;
    if(s.needsReconnect)return null;
    if(!force&&s.expires_at&&now()<s.expires_at-5*60*1000)return s.access_token;
    if(!s.refresh_token)return force?null:s.access_token;
    if(!refreshing)refreshing=(async()=>{
      let r;
      try{
        r=await fetchImpl(AUTH+'/oauth/token/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
          body:form({grant_type:'refresh_token',refresh_token:s.refresh_token,client_id:s.client_id,resource:MCP}),signal:AbortSignal.timeout(15000)});
      }catch{await save({...s,lastError:'Monarch could not be reached to renew access.'});return null;}
      if(r.status>=400&&r.status<500){
        // The grant itself is dead (revoked, expired, rotated elsewhere). Only a new sign-in fixes that,
        // and the status says so rather than failing quietly on every refresh.
        await save({...s,access_token:null,needsReconnect:true,lastError:'Monarch access has expired. Reconnect Monarch to resume.'});
        return null;
      }
      if(!r.ok){await save({...s,lastError:'Monarch could not renew access (HTTP '+r.status+'). It will retry.'});return null;}
      const t=await r.json();
      const next=await save({...s,access_token:t.access_token,refresh_token:t.refresh_token||s.refresh_token,
        expires_at:now()+(Number(t.expires_in)||3600)*1000,lastError:null});
      return next.access_token;
    })().finally(()=>{refreshing=null});
    return refreshing;
  }

  // ── Transport ──────────────────────────────────────────────────────────
  let rpcId=0;
  async function post(token,body){
    const headers={Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':PROTOCOL};
    if(sessionId)headers['Mcp-Session-Id']=sessionId;
    let r;
    try{r=await fetchImpl(MCP,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});}
    catch(e){throw new Error(e?.name==='TimeoutError'?'Monarch timed out returning financial data.':'Monarch could not be reached.');}
    const sid=r.headers?.get?.('mcp-session-id');if(sid)sessionId=sid;
    return r;
  }
  async function initialize(token){
    if(!initialized)initialized=(async()=>{
      const r=await post(token,{jsonrpc:'2.0',id:++rpcId,method:'initialize',params:{protocolVersion:PROTOCOL,capabilities:{},clientInfo:{name:'cohen-planner',version:'1'}}});
      if(!r.ok)throw Object.assign(new Error('Monarch MCP handshake failed (HTTP '+r.status+').'),{status:r.status});
      parseSSEorJSON(await r.text());
      await post(token,{jsonrpc:'2.0',method:'notifications/initialized'}).catch(()=>{});
    })().catch(e=>{initialized=null;throw e;});
    return initialized;
  }
  async function rpc(method,params,retried=false){
    let token=await accessToken();
    if(!token)throw new Error('Monarch is not connected. Connect Monarch to resume.');
    try{await initialize(token);}
    catch(e){if(e.status===401&&!retried){await accessToken(true);sessionId=null;return rpc(method,params,true);}throw e;}
    const r=await post(token,{jsonrpc:'2.0',id:++rpcId,method,params});
    if((r.status===401||r.status===404)&&!retried){
      // 401: the access token lapsed early. 404: the server forgot the MCP session. Both get one clean retry.
      if(r.status===401)await accessToken(true);
      sessionId=null;initialized=null;
      return rpc(method,params,true);
    }
    if(r.status===429)throw new Error('Monarch is rate-limiting requests. Wait before trying again.');
    if(!r.ok)throw new Error('Monarch request failed (HTTP '+r.status+').');
    const msg=parseSSEorJSON(await r.text());
    if(msg.error)throw new Error('Monarch rejected the request ('+(msg.error.code??'error')+').');
    return msg.result;
  }

  async function tools(force=false){
    if(!toolsCache||force){
      const out=[];let cursor;
      for(let i=0;i<20;i++){
        const res=await rpc('tools/list',cursor?{cursor}:{});
        out.push(...(res?.tools||[]));
        cursor=res?.nextCursor;if(!cursor)break;
      }
      toolsCache=out;
    }
    return toolsCache;
  }
  async function tool(name){
    const t=(await tools()).find(x=>x.name===name);
    if(!t)throw new Error(`Monarch's MCP has no ${name} tool.`);
    return t;
  }

  // Arguments from the tool's own schema. `want` holds what the caller means — {startDate, endDate,
  // limit, offset} — and each is matched to whichever property the schema names for it. A wanted filter
  // the tool cannot take is reported, never dropped, because an unfiltered result would be read as the
  // filtered one.
  const ALIASES={
    startDate:[/^start_?date$/i,/^from(_?date)?$/i,/^date_?from$/i,/^since$/i],
    endDate:[/^end_?date$/i,/^to(_?date)?$/i,/^date_?to$/i,/^until$/i],
    limit:[/^limit$/i,/^page_?size$/i,/^max_?results$/i,/^count$/i],
    offset:[/^offset$/i,/^skip$/i,/^start$/i],
  };
  function buildArgs(t,want={}){
    const props=t.inputSchema?.properties||{},names=Object.keys(props),args={},missing=[];
    for(const [k,v] of Object.entries(want)){
      if(v==null)continue;
      const prop=names.find(n=>(ALIASES[k]||[new RegExp('^'+k+'$','i')]).some(re=>re.test(n)));
      if(prop)args[prop]=v;else missing.push(k);
    }
    // Monarch asks every data call what kind of task it serves, and shares that with the institutions
    // behind the data, so it stays generic.
    if(props.intent){
      const options=props.intent.enum||[];
      const pick=['financial_planning','budgeting','net_worth','investing','cash_flow'].find(o=>options.includes(o));
      if(pick)args.intent=pick;
      else if(options.includes('other')||!options.length){args.intent=options.length?'other':'financial planning';
        if(props.intent_description)args.intent_description='personal financial planning';}
      else args.intent=options[0];
    }
    return {args,missing,props:names};
  }
  async function call(name,want={}){
    const t=await tool(name);
    const {args,missing}=buildArgs(t,want);
    return {payload:toolPayload(await rpc('tools/call',{name,arguments:args})),missing,schema:t.inputSchema||{}};
  }

  async function status(){
    const s=await load();
    return {connected:!!(s?.access_token||s?.refresh_token)&&!s?.needsReconnect,needsReconnect:!!s?.needsReconnect,
      connectedAt:s?.connectedAt||null,lastError:s?.lastError||null};
  }
  async function disconnect(){
    const s=await load();
    if(s?.refresh_token)fetchImpl(AUTH+'/oauth/revoke/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:form({token:s.refresh_token,client_id:s.client_id,token_type_hint:'refresh_token'}),signal:AbortSignal.timeout(10000)}).catch(()=>{});
    sessionId=null;initialized=null;toolsCache=null;
    await save({client_id:s?.client_id||null,redirect_uri:s?.redirect_uri||null});
  }
  return {startConnect,finishConnect,accessToken,rpc,tools,call,buildArgs,status,disconnect};
}
module.exports={createMonarchMcp,parseSSEorJSON,toolPayload,AUTH,MCP,KEY,SCOPE};
