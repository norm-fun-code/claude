'use strict';
const Time=require('./public/planner-time');
const TTL=5*60*1000;
const QUERY=`query Web_GetHoldings($input: PortfolioInput) { portfolio(input:$input) { aggregateHoldings { edges { node {
 id quantity totalValue lastSyncedAt securityPriceChangeDollars
 security { id name type ticker currentPrice }
 holdings { id type name ticker }
} } } } }`;
function periodStart(period,end){
  const d=new Date(end+'T12:00:00Z');
  if(period==='YTD')return end.slice(0,4)+'-01-01';
  if(period==='1W')d.setUTCDate(d.getUTCDate()-7);
  else if(period==='1Y')d.setUTCFullYear(d.getUTCFullYear()-1);
  else d.setUTCMonth(d.getUTCMonth()-(period==='3M'?3:1));
  return d.toISOString().slice(0,10);
}
const number=v=>v==null||v===''?null:Number.isFinite(Number(v))?Number(v):null;
function normalizeHoldings(data,period,now){
  const edges=data?.portfolio?.aggregateHoldings?.edges;
  if(!Array.isArray(edges))throw new Error('Monarch returned incomplete holdings. Saved positions were kept.');
  const holdings=edges.map(({node:n}={})=>{
    const value=number(n?.totalValue),quantity=number(n?.quantity),delta=number(n?.securityPriceChangeDollars);
    if(!n||value===null)throw new Error('Monarch returned an unreadable position. Saved positions were kept.');
    const security=n.security||n.holdings?.[0]||{};
    const prior=quantity>0&&delta!==null?value/quantity-delta:null;
    return {id:String(n.id),ticker:security.ticker||security.name||'Untitled',name:security.name||'',
      securityType:security.type||'other',value,quantity,asOf:n.lastSyncedAt||null,
      periodChange:quantity!==null&&delta!==null?quantity*delta:null,
      periodChangePct:prior>0?delta/prior*100:null,allTimeChange:null,allTimePct:null};
  }).sort((a,b)=>b.value-a.value);
  const complete=holdings.length>0&&holdings.every(h=>h.periodChange!==null);
  const totalValue=holdings.reduce((s,h)=>s+h.value,0),change=complete?holdings.reduce((s,h)=>s+h.periodChange,0):null;
  return {source:'monarch-direct',asOf:new Date(now).toISOString(),holdings,totalValue,period,
    periodStart:periodStart(period,Time.day(new Date(now))),periodEnd:Time.day(new Date(now)),
    periodMetric:'price',periodChange:change,periodChangePct:change!==null&&totalValue-change>0?change/(totalValue-change)*100:null,
    allTimeChange:null,allTimePct:null,topGainers:holdings.filter(h=>h.periodChange>0).sort((a,b)=>b.periodChange-a.periodChange).slice(0,5),
    topLosers:holdings.filter(h=>h.periodChange<0).sort((a,b)=>a.periodChange-b.periodChange).slice(0,5)};
}
function createMonarchHoldings({db,client,env=process.env,fetchImpl=fetch,now=Date.now}) {
  client=client||require('./monarch-client').createMonarchClient({db,env,fetchImpl});
  const cache=new Map(),pending=new Map();
  return function holdings(period='1M',force=false){
    if(!['1W','1M','3M','YTD','1Y'].includes(period))return Promise.reject(new Error('Choose a valid holdings period.'));
    if(pending.has(period))return pending.get(period);
    const fresh=cache.get(period);if(!force&&fresh&&now()-fresh.at<TTL)return Promise.resolve(fresh.body);
    const job=(async()=>{
      const key='monarch_holdings_'+period;
      const state=(await db.query('SELECT data FROM oauth_tokens WHERE key = $1',['monarch_accounts_cache'])).rows[0]?.data;
      if(state?.disabled)throw new Error('Monarch sync is paused. Enable sync to resume.');
      let saved=fresh?.body||(await db.query('SELECT data FROM oauth_tokens WHERE key = $1',[key])).rows[0]?.data?.snapshot;
      try{
        const endDate=Time.day(new Date(now()));
        const data=await client.query('Web_GetHoldings',QUERY,{input:{startDate:periodStart(period,endDate),endDate,includeHiddenHoldings:false}});
        const body=normalizeHoldings(data,period,now());
        await db.query('INSERT INTO oauth_tokens (key,data) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data',[key,JSON.stringify({snapshot:body})]);
        cache.set(period,{at:now(),body});return body;
      }catch(err){if(!saved)throw err;const body={...saved,stale:true,warning:err.message};cache.set(period,{at:now(),body});return body;}
    })().finally(()=>pending.delete(period));pending.set(period,job);return job;
  };
}
module.exports={createMonarchHoldings,normalizeHoldings,periodStart,QUERY};
