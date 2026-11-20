'use strict';

const ID='2026-11-19-age-based-family-budget';
const BASES={
  baseGroceries:7200,baseDining:12000,baseShopping:23400,clothingShare:4300/23400,
  baseVacations:18000,postKidVacations:18000,baseMisc:12000,baseEntertainment:4500,
  baseCharity:7200,baseMedical:5100,baseUtilsPhoneNet:3900,
};
const AGE={ 'baby-gear':[0,0], camp:[5,12], mitzvah:[13,13] };
const LEGACY_IDS=['home-furnish-2030','home-furnish-2031','baby-gear-2-2029','baby-gear-2-2030'];
function updatePlan(p){
  // Match the audited household, not arbitrary demos, unrelated scenarios or new plans.
  if(!p||p.familyBudgetCalibration||p.planStartYear!==2026||p.kid1Birth!==2027||
    p.kid2Birth!==2029||p.kid3Birth!==2032||p.kid4Birth!==2036||p.childcareMonthly!==3800||
    !LEGACY_IDS.every(id=>p.planItems?.some(x=>x?.sid===id)))return p;
  const q={...p,nycFamilyBudget:true,familyBudgetCalibration:ID,
    kid1CareSchedule:[{fromMonth:8,untilMonth:18,monthly:3800},{fromMonth:18,rateShare:.5}]};
  const old={baseGroceries:7000,baseDining:14000,baseShopping:22000,clothingShare:.3,
    baseVacations:15000,postKidVacations:10000,baseMisc:10000,baseEntertainment:4500,
    baseCharity:5000,baseMedical:4500,baseUtilsPhoneNet:5500};
  // Do not overwrite any line the household edited after the audit.
  for(const [key,value] of Object.entries(BASES))if(p[key]===old[key])q[key]=value;
  if(q.livingUtilitiesY1===2000)delete q.livingUtilitiesY1;
  q.planItems=p.planItems.filter(it=>it?.sid!=='home-furnish-2030'&&it?.sid!=='baby-gear-2-2030').map(it=>{
    if(!it)return it;
    if(it.sid==='home-furnish-2031')return {...it,anchor:'purchase'};
    const m=/^(baby-gear|camp|mitzvah)-([1-4])-\d{4}$/.exec(it.sid||'');
    if(!m)return it;
    const child=Number(m[2]),birth=p['kid'+child+'Birth'],[fromAge,toAge]=AGE[m[1]];
    return {...it,sid:m[1]+'-'+child+'-'+birth,child,fromAge,toAge,from:birth+fromAge,to:birth+toAge};
  });
  for(const [kind,category,label,amount,grow] of [
    ['baby-gear','oneoff','baby gear and first-year extras',6000,false],
    ['camp','entertainment','summer camp',8000,true],
    ['mitzvah','oneoff','bar/bat mitzvah',25000,false],
  ]){
    if(q.planItems.some(it=>it?.child===4&&it.sid?.startsWith(kind+'-')))continue;
    const [fromAge,toAge]=AGE[kind];
    q.planItems.push({sid:kind+'-4-'+p.kid4Birth,label:'Kid 4 — '+label,category,child:4,fromAge,toAge,from:p.kid4Birth+fromAge,to:p.kid4Birth+toAge,amount,grow});
  }
  return q;
}
function repairState(state){
  const P=updatePlan(state.P),livePlanParams=updatePlan(state.livePlanParams);
  return P===state.P&&livePlanParams===state.livePlanParams?state:{...state,P,livePlanParams};
}
async function apply(pool){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[ID]);
    const done=await c.query('SELECT id FROM planner_data_updates WHERE id=$1',[ID]);
    if(done.rowCount){await c.query('COMMIT');return {alreadyApplied:true};}
    const row=(await c.query('SELECT state FROM planner_state WHERE id=1 FOR UPDATE')).rows[0];
    const next=row&&repairState(row.state);
    if(next&&next!==row.state){
      await c.query('UPDATE planner_state SET state=$1,updated_at=NOW() WHERE id=1',[JSON.stringify(next)]);
      await c.query('INSERT INTO planner_data_updates(id,details) VALUES($1,$2)',[ID,JSON.stringify({previousState:row.state})]);
    }
    await c.query('COMMIT');
    return {updated:!!next&&next!==row.state,workingPlan:!!next&&next.P!==row.state.P};
  }catch(err){await c.query('ROLLBACK').catch(()=>{});throw err;}
  finally{c.release();}
}
module.exports={ID,updatePlan,repairState,apply};
