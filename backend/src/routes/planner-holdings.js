// Extend the existing read-only planner bridge with a fixed holdings feed.
// No arbitrary GraphQL, account mutation, or Monarch credential leaves NormOS.
const {periodWindow,shapePortfolio}=require('../services/planner-holdings');
function installHoldingsRoute(router,{db,api,env,now,authorize}) {
  const inflight=new Map(), cooldown=new Map();
  const ttl=5*60*1000;
  async function read(period) {
    const window=periodWindow(period,now());
    const {rows}=await db.query("SELECT id, config FROM sources WHERE id IN ('monarch','monarch_api','monarch_mcp_sync')");
    let saved=rows.find(r=>r.id==='monarch')?.config?.plannerHoldings?.[period];
    if(!Array.isArray(saved?.holdings)||!saved.holdings.length||!Number.isFinite(Date.parse(saved.asOf)))saved=null;
    if(saved&&saved.periodEnd===window.endDate&&now()-Date.parse(saved.asOf)<ttl)return {...saved,stale:false,warning:null};
    const token=env.MONARCH_TOKEN||rows.find(r=>r.config?.monarchToken)?.config.monarchToken;
    let warning=cooldown.get(period)?.warning;
    if(!cooldown.has(period)||now()>=cooldown.get(period).until){
      try {
        if(!token)throw new Error('no_session');
        const holdings=await api.getPlannerHoldings(token,window);
        const next={...shapePortfolio(holdings,window),asOf:new Date(now()).toISOString(),source:'normos-bridge'};
        await db.query("INSERT INTO sources (id,domain,display_name) VALUES ('monarch','wealth','Monarch') ON CONFLICT (id) DO NOTHING");
        await db.query(`UPDATE sources SET config=jsonb_set(COALESCE(config,'{}'::jsonb),'{plannerHoldings}',COALESCE(config->'plannerHoldings','{}'::jsonb)||jsonb_build_object($1::text,$2::jsonb)) WHERE id='monarch'`,[period,JSON.stringify(next)]);
        cooldown.delete(period);
        return {...next,stale:false,warning:null};
      }catch(e){
        const status=e.response?.status;
        warning=status===401?'The Monarch connection in NormOS needs to reconnect.'
          :status===429?'Monarch is temporarily rate-limiting holdings refreshes.'
          :!token?'NormOS has no active Monarch session for holdings.'
          :'NormOS could not refresh individual holdings. Try again shortly.';
        cooldown.set(period,{until:now()+ttl,warning});
      }
    }
    if(saved)return {...saved,stale:true,warning};
    throw new Error(warning);
  }
  router.get('/holdings',authorize,async(req,res)=>{
    const period=req.query.period||'1M';
    try{periodWindow(period,now());}catch(e){return res.status(400).json({error:e.message});}
    try{
      if(!inflight.has(period))inflight.set(period,read(period).finally(()=>inflight.delete(period)));
      res.json(await inflight.get(period));
    }catch(e){res.status(503).json({error:e.message});}
  });
}
module.exports={installHoldingsRoute};
