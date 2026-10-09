'use strict';
// Balances read directly from Monarch. Durable last observations survive outages and deploys.
const {extractAccounts}=require('./monarch-accounts');
const {readBalances}=require('./monarch-balances');
const KEY='monarch_accounts_cache',TTL=5*60*1000;
function validSnapshot(value){
  if(value?.version!==1||!Number.isFinite(Date.parse(value.asOf)))return null;
  try{extractAccounts(value.accounts);return value;}catch{return null;}
}
function createMonarchLive({db,fetchImpl=fetch,env=process.env,now=Date.now,client}={}) {
  client=client||require('./monarch-client').createMonarchClient({db,env,fetchImpl});
  let pending,retryAfter=0,lastWarning=null;
  async function context(){return (await db.query('SELECT data FROM oauth_tokens WHERE key = $1',[KEY])).rows[0]?.data||{};}
  async function save(data){await db.query('INSERT INTO oauth_tokens (key,data) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET data = oauth_tokens.data || EXCLUDED.data',[KEY,JSON.stringify(data)]);}
  async function setEnabled(enabled){await save({disabled:!enabled});}
  async function status(){const c=await context();return {connected:!c.disabled,source:'monarch-direct',asOf:c.snapshot?.asOf||null};}
  async function pull(force=false){
    const c=await context();if(c.disabled)throw new Error('Monarch sync is paused. Enable sync to resume.');
    let snapshot=validSnapshot(c.snapshot),warning=lastWarning;
    if(now()>=retryAfter&&(force||!snapshot||now()-Date.parse(snapshot.asOf)>=TTL)){
      try{snapshot=await readBalances(client,now);warning=null;await save({snapshot,lastError:null});}
      catch(err){warning=err.message;await save({lastError:warning});if(!snapshot)throw err;}
      lastWarning=warning;retryAfter=now()+TTL;
    }
    if(!snapshot)throw new Error('Waiting for the first Monarch balance refresh.');
    return {...snapshot,stale:now()-Date.parse(snapshot.asOf)>86400000,warning:warning||c.lastError||null,bankUpdatedAt:null};
  }
  function getSnapshot(force=false){if(!pending)pending=pull(force).finally(()=>pending=null);return pending;}
  async function diagnose(){
    try{const snap=await getSnapshot(true);return {ok:!snap.warning,checks:[{name:'Direct Monarch balances',ok:!snap.warning,kind:'check',detail:snap.warning||`${snap.accounts.length} readable accounts · ${snap.missingAccounts?.length||0} missing balances · observed ${snap.asOf}`,fix:null}]};}
    catch(err){return {ok:false,checks:[{name:'Direct Monarch balances',ok:false,detail:err.message,kind:'check',fix:null}]};}
  }
  return {status,setEnabled,getSnapshot,diagnose};
}
module.exports={createMonarchLive,validSnapshot,TTL};
