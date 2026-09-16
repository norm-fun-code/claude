'use strict';
// Only NormOS owns the upstream Monarch session.
// NormOS refreshes from Monarch at most once every five minutes, so asking faster cannot
// produce newer data. Without this, every accounts-overview load fired its own uncached
// request with a 60-second budget and then abandoned it after 1.5s — paying for the upstream
// call, discarding the answer, and reporting holdings unavailable almost every time.
const TTL = 5 * 60 * 1000;

function createHoldingsBridge({db,env=process.env,fetchImpl=fetch,now=Date.now}) {
  const cache=new Map();   // period -> {at, body}
  const inflight=new Map();// period -> promise, so concurrent callers share one request
  return async function holdings(period='1M') {
    const fresh=cache.get(period);
    if(fresh&&now()-fresh.at<TTL)return fresh.body;
    if(inflight.has(period))return inflight.get(period);
    const p=fetchHoldings(period).then(body=>{cache.set(period,{at:now(),body});return body})
      .finally(()=>inflight.delete(period));
    inflight.set(period,p);
    return p;
  };

  async function fetchHoldings(period) {
    if(!['1W','1M','3M','YTD','1Y'].includes(period))throw new Error('Choose a valid holdings period.');
    const {rows}=await db.query("SELECT data FROM oauth_tokens WHERE key = 'monarch_bridge'");
    if(rows[0]?.data?.disabled)throw new Error('Planner sync is paused. Enable NormOS sync to resume.');
    if(!env.NORMOS_URL||!env.PLANNER_BRIDGE_TOKEN)throw new Error('The NormOS connection is not configured.');
    const base=new URL(env.NORMOS_URL);
    if(base.protocol!=='https:'||base.username||base.password)throw new Error('NormOS must use an HTTPS origin.');
    const url=new URL('/integrations/planner/holdings',base);url.searchParams.set('period',period);
    let response;
    try{response=await fetchImpl(url.href,{headers:{Authorization:`Bearer ${env.PLANNER_BRIDGE_TOKEN}`},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(60000)});}
    catch{throw new Error('NormOS could not be reached for holdings. Try again shortly.');}
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(response.status===401?'NormOS rejected the planner connection.':body?.error||'NormOS holdings are temporarily unavailable.');
    if(!Array.isArray(body?.holdings)||!body.holdings.length||!Number.isFinite(Date.parse(body.asOf))||!body.holdings.every(h=>typeof h.ticker==='string'&&Number.isFinite(h.value)))throw new Error('NormOS returned incomplete holdings.');
    return body;
  }
}
module.exports={createHoldingsBridge};
