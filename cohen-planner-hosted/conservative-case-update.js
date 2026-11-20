'use strict';

const {scenarioKey}=require('./audited-comp-scenarios');
const {patchConservativeComp}=require('./promotion-comp-scenarios');
const ID='conservative-2027-l4-flat-stripe-slower-practice-20261120';
const NANCY={nancyRampYear:2030,nancyRampClients:4,nancyMaxClients:12,nancyRampYears:4,nancyHourlyRate:250,nancyWeeksPerYear:44};
const RETURN=Object.fromEntries(Array.from({length:10},(_,i)=>['stripeRetY'+i,0]));

function patch(params) {
  return {...patchConservativeComp(params),...NANCY,...RETURN,stripeLongTermReturn:0};
}

async function apply(pool) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[ID]);
    const done=await c.query('SELECT id FROM planner_data_updates WHERE id=$1',[ID]);
    if(done.rowCount){await c.query('COMMIT');return {alreadyApplied:true};}
    const saved=(await c.query('SELECT state FROM planner_state WHERE id=1 FOR UPDATE')).rows[0]?.state;
    const cases=(await c.query('SELECT id,name,params FROM scenarios ORDER BY created_at FOR UPDATE')).rows;
    const targets=cases.filter(s=>s.params&&!s.params._archived&&scenarioKey(s.name)==='conservative');
    if(targets.length!==1){await c.query('ROLLBACK');return {skipped:'Expected one active Conservative case'};}
    const target=targets[0];
    const active=!!(saved?.P&&!saved.scenarioDirty&&saved.activeScenarioId===target.id);
    const next=patch(target.params);
    const backup={scenario:{id:target.id,params:target.params},...(active?{previousState:saved}:{})};
    await c.query('UPDATE scenarios SET params=$1,results=NULL,updated_at=NOW() WHERE id=$2',[JSON.stringify(next),target.id]);
    if(active)await c.query('UPDATE planner_state SET state=$1,updated_at=clock_timestamp() WHERE id=1',[JSON.stringify({...saved,P:patch(saved.P)})]);
    await c.query('INSERT INTO planner_data_updates(id,details) VALUES($1,$2)',[ID,JSON.stringify(backup)]);
    await c.query('COMMIT');
    return {updated:true,activeCaseRefreshed:active};
  } catch(e) {
    await c.query('ROLLBACK').catch(()=>{});
    throw e;
  } finally {c.release();}
}
module.exports={ID,patch,apply};
