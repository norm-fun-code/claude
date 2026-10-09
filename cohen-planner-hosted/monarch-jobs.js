'use strict';
const Time=require('./public/planner-time');
const KEY='monarch_daily_sync',LOCK=74027501;
function createMonarchJobs({db,live,holdings,sync,now=Date.now}) {
  let running=false,timer;
  async function state(){return (await db.query('SELECT data FROM oauth_tokens WHERE key = $1',[KEY])).rows[0]?.data||{};}
  async function save(data){await db.query('INSERT INTO oauth_tokens (key,data) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET data=oauth_tokens.data||EXCLUDED.data',[KEY,JSON.stringify(data)]);}
  async function execute(task){
    if(running)throw new Error('An import is already running.');running=true;
    let connection,locked=false;
    try{
      connection=await db.pool.connect();
      locked=(await connection.query('SELECT pg_try_advisory_lock($1) AS locked',[LOCK])).rows[0].locked;
      if(!locked)throw new Error('An import is already running.');
      return await task();
    }finally{if(locked)await connection.query('SELECT pg_advisory_unlock($1)',[LOCK]).catch(()=>{});connection?.release();running=false;}
  }
  async function daily(){
    if(running)return;
    const previous=await state(),stamp=now();
    if(previous.lastSuccessAt&&Time.day(new Date(previous.lastSuccessAt))===Time.day(new Date(stamp)))return;
    if(previous.lastAttemptAt&&stamp-Date.parse(previous.lastAttemptAt)<30*60*1000)return;
    if(!(await live.status()).connected)return;
    return execute(async()=>{
      await save({lastAttemptAt:new Date(stamp).toISOString(),lastError:null});
      const sources={},errors=[];
      for(const [name,read] of [
        ['balances',()=>live.getSnapshot(true)],['holdings',()=>holdings('1M',true)],
        ['transactions',async()=>{await sync.syncCategories();return sync.incremental({lookbackDays:45});}]
      ]){
        try{const result=await read();if(result.warning)throw new Error(result.warning);sources[name]={ok:true,asOf:new Date(now()).toISOString()};}
        catch(err){sources[name]={ok:false,error:err.message};errors.push(name+': '+err.message);}
      }
      const done=new Date(now()).toISOString();
      await save({sources,lastFinishedAt:done,lastError:errors.length?errors.join(' · '):null,...(!errors.length?{lastSuccessAt:done}:{})});
      return {sources};
    });
  }
  function start(){if(timer)return;const tick=()=>daily().catch(err=>console.error('Monarch daily refresh:',err.message));tick();timer=setInterval(tick,5*60*1000);timer.unref();}
  return {execute,daily,start,status:async()=>({...await state(),running,schedule:'Daily; retries every 30 minutes after a failure',timezone:'America/New_York'}),get running(){return running}};
}
module.exports={createMonarchJobs};
