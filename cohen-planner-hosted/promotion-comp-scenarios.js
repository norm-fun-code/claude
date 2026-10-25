'use strict';

// User-approved October 22 preview. Compensation only; investment returns and
// already-owned Stripe shares retain their existing valuation assumptions.
const UPDATE_ID='l4-2027-march-salary-zero-vest-appreciation-20261022-v1';
const PROMOTIONS={base:[2027,2033],optimistic:[2027,2032]};
function schedule(key){
  const promotions=PROMOTIONS[key];
  if(!promotions)throw new Error('Unsupported compensation case');
  const level=y=>y>=promotions[1]?5:y>=promotions[0]?4:3;
  const multiplier=y=>promotions.some(p=>y===p+1||y===p+2)?1:1.5;
  const salary=y=>{let value=210000;for(let t=2027;t<=y;t++)value*=promotions.includes(t)?1.08:1.03;return value;};
  // Retain the preview's bonus convention: prior December salary, prior level
  // and rating. Annual payroll alone is prorated for the March effective date.
  const peg=y=>({3:50000,4:65000,5:100000}[level(y-1)])*multiplier(y-1);
  return Array.from({length:11},(_,i)=>{
    const year=2027+i;
    const earnedSalary=salary(year-1)/6+salary(year)*5/6;
    const bonus=salary(year-1)*({3:.15,4:.20,5:.25}[level(year-1)])*multiplier(year-1);
    // June/September/December then March: 3/8,4/8,1/8 of overlapping PEGs.
    // Historical 2025/26 PEGs use the preview's estimated L3 Exceeds grants.
    // ARG is the annual face-value refresh; no pre-vest appreciation in either.
    const stock=({3:80000,4:100000,5:150000}[level(year)])+peg(year)*3/8+peg(year-1)/2+peg(year-2)/8;
    return {year,cash:Math.round(earnedSalary+bonus),stock:Math.round(stock)};
  });
}
function patchComp(params,key){
  const out={...params};
  const start=Number(out.planStartYear||2026);
  if(!Number.isInteger(start)||start<2024||start>2037)throw new Error('Unsupported plan start year');
  const later={...(out.stripeManualLater||{})};
  for(const {year,cash,stock} of schedule(key)){
    if(year<start)continue;
    if(year-start<11){out['normCashY'+(year-start)]=cash;out['normStockY'+(year-start)]=stock;}
    else later[year]={...(later[year]||{}),cash,stock};
  }
  out.stripeManualLater=later;
  out.stripeSimplified=true;
  if(out.stripeGrants?.enabled)out.stripeGrants={...out.stripeGrants,enabled:false};
  return out;
}
async function applyPromotionCompScenarios(pool){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[UPDATE_ID]);
    const done=await client.query('SELECT id FROM planner_data_updates WHERE id=$1',[UPDATE_ID]);
    if(done.rowCount){await client.query('COMMIT');return {alreadyApplied:true};}
    const saved=await client.query('SELECT state FROM planner_state WHERE id=1 FOR UPDATE');
    const state=saved.rows[0]?.state||{};
    const cases=(await client.query('SELECT id,name,params FROM scenarios ORDER BY created_at FOR UPDATE')).rows;
    const {scenarioKey}=require('./audited-comp-scenarios');
    const matched=Object.keys(PROMOTIONS).map(key=>({key,row:cases.find(s=>scenarioKey(s.name)===key&&!s.params?._archived)}));
    if(matched.some(m=>!m.row)){await client.query('ROLLBACK');return {skipped:'Base and Optimistic must both exist'};}
    const result={updated:[],backup:[]};
    for(const {key,row} of matched){
      result.backup.push({id:row.id,params:row.params});
      await client.query('UPDATE scenarios SET params=$1,results=NULL,updated_at=NOW() WHERE id=$2',[JSON.stringify(patchComp(row.params,key)),row.id]);
      result.updated.push({id:row.id,name:row.name});
      if(state.activeScenarioId===row.id&&!state.scenarioDirty&&state.P){state.P=patchComp(state.P,key);result.activeCaseRefreshed=true;}
    }
    if(result.activeCaseRefreshed)await client.query('UPDATE planner_state SET state=$1,updated_at=NOW() WHERE id=1',[JSON.stringify(state)]);
    // Backup remains in the update journal for recovery; never printed to logs.
    await client.query('INSERT INTO planner_data_updates(id,details) VALUES($1,$2)',[UPDATE_ID,JSON.stringify(result)]);
    await client.query('COMMIT');
    return {updated:result.updated,activeCaseRefreshed:!!result.activeCaseRefreshed};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}
// The working plan and its saved "live plan" snapshot can outlive a case
// migration (including an autosave from a phone that was already open).
// Repair ONLY an exact old audited compensation schedule, preserving all other
// fields and any genuinely edited compensation schedule.
function legacyCase(params){
  if(!params)return null;
  const {DATA}=require('./audited-comp-scenarios');
  const start=Number(params.planStartYear||2026);
  for(const key of Object.keys(PROMOTIONS)){
    let count=0,match=true;
    for(const [year,cash,stock] of DATA[key]){
      if(year<2027||year<start)continue;
      const i=year-start;
      const c=i<11?params['normCashY'+i]:params.stripeManualLater?.[year]?.cash;
      const s=i<11?params['normStockY'+i]:params.stripeManualLater?.[year]?.stock;
      if(c==null&&s==null)continue;
      count++;
      if(c!==cash*1000||s!==stock*1000){match=false;break;}
    }
    if(match&&count>=5)return key;
  }
  return null;
}
function repairState(state){
  const out={...state};let changed=false;
  for(const field of ['P','livePlanParams']){
    const key=legacyCase(state[field]);
    if(key){out[field]=patchComp(state[field],key);changed=true;}
  }
  return {state:out,changed};
}
async function repairLegacyCompSnapshots(pool){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[UPDATE_ID+'-snapshots']);
    const row=(await client.query('SELECT state FROM planner_state WHERE id=1 FOR UPDATE')).rows[0];
    const fixed=repairState(row?.state||{});
    if(fixed.changed){
      await client.query('UPDATE planner_state SET state=$1,updated_at=NOW() WHERE id=1',[JSON.stringify(fixed.state)]);
      await client.query('INSERT INTO planner_data_updates(id,details) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[UPDATE_ID+'-snapshots',JSON.stringify({previousState:row.state})]);
    }
    await client.query('COMMIT');return {repaired:fixed.changed};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}
module.exports={UPDATE_ID,PROMOTIONS,schedule,patchComp,applyPromotionCompScenarios,legacyCase,repairState,repairLegacyCompSnapshots};
