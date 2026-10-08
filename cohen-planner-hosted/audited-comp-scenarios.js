'use strict';

// One-time, narrowly scoped update of saved compensation scenarios.
// Does not change housing, spending, net-worth opening balances, Nancy income,
// investment returns, or Stripe holdings. Do not use as a general migration.
const UPDATE_ID = 'audited-stripe-comp-2026-10-08-v1';

// Values in USD thousands, from the audited compensation tables.
// Annual equity grant remains part of Stock, not Cash.
const DATA = {
  conservative: [
    [2026,257,155],[2027,264,155],[2028,255,149],[2029,263,136],
    [2030,282,150],[2031,305,154],[2032,314,161],[2033,323,165],
    [2034,333,165],[2035,343,165],[2036,353,165],[2037,364,165]
  ],
  base: [
    [2026,257,155],[2027,264,163],[2028,271,165],[2029,291,183],
    [2030,320,187],[2031,305,190],[2032,314,179],[2033,350,178],
    [2034,360,195],[2035,385,254],[2036,423,268],[2037,397,283]
  ],
  optimistic: [
    [2026,257,155],[2027,264,169],[2028,282,192],[2029,311,193],
    [2030,296,193],[2031,305,181],[2032,340,180],[2033,363,248],
    [2034,399,271],[2035,374,287],[2036,386,275],[2037,436,273]
  ]
};
const COLORS = {conservative:'#20c997',base:'#339af0',optimistic:'#845ef7'};

function scenarioKey(name) {
  const s = String(name || '').trim().toLowerCase().replace(/[-_]+/g,' ').replace(/\s+/g,' ');
  const match = /^(conservative|base|optimistic)(?: case| scenario| plan)?$/.exec(s);
  return match ? match[1] : null;
}

function patchComp(src, key) {
  if (!DATA[key]) throw new Error('Unknown scenario type: ' + key);
  const p = {...(src || {})};
  const start = Number(p.planStartYear || 2026);
  if (!Number.isInteger(start) || start < 2024 || start > 2037) {
    throw new Error('Cannot safely map year-by-year compensation for start year ' + start);
  }
  // Explicit year-key grid is limited to the first eleven calendar years.
  // Preserve any earlier/later manual years that were already modeled.
  let later = {...(p.stripeManualLater || {})};
  for (const [year,cash,stock] of DATA[key]) {
    if (year < start) continue;
    if (year - start < 11) {
      p['normCashY' + (year-start)] = cash * 1000;
      p['normStockY' + (year-start)] = stock * 1000;
    } else {
      later[year] = {...(later[year] || {}),cash:cash*1000,stock:stock*1000};
    }
  }
  p.stripeManualLater = later;
  // Comp figures were computed from the award / vest ledger already. Recalculating
  // active award schedules on top of them would overwrite or double-count stock.
  if (p.stripeGrants?.enabled === true) {
    p.stripeGrants = {...p.stripeGrants,enabled:false};
  }
  p.stripeSimplified = true;
  return p;
}

async function applyAuditedCompScenarios(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS planner_data_updates
      (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), details JSONB)`);
    // A single transaction and lock prevent duplicate writes across replicas.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[UPDATE_ID]);
    const already = await client.query('SELECT id FROM planner_data_updates WHERE id=$1',[UPDATE_ID]);
    if (already.rowCount) { await client.query('COMMIT'); return {alreadyApplied:true}; }

    const stateResult=await client.query('SELECT state FROM planner_state WHERE id=1 FOR UPDATE');
    const state=stateResult.rows[0]?.state || {};
    const seed=state.livePlanParams || state.P;
    if (!seed || typeof seed !== 'object' || !Object.keys(seed).length) {
      await client.query('ROLLBACK');
      return {skipped:'No saved planner state to preserve for new scenarios'};
    }

    const existing = (await client.query('SELECT id,name,params FROM scenarios ORDER BY created_at FOR UPDATE')).rows;
    const result={updated:[],created:[],leftUnchanged:[]};
    const ids={};
    for (const key of Object.keys(DATA)) {
      const matches=existing.filter(r=>scenarioKey(r.name)===key && !(r.params||{})._archived);
      if (matches.length) {
        // Prefer the first existing canonical case. Do not change any other named
        // scenarios (and do not make duplicate changes to similarly named copies).
        const s=matches[0], p=patchComp(s.params,key);
        await client.query('UPDATE scenarios SET params=$1,results=NULL,updated_at=NOW() WHERE id=$2',
          [JSON.stringify(p),s.id]);
        ids[s.id]=key;result.updated.push({id:s.id,name:s.name});
        for (const other of matches.slice(1)) result.leftUnchanged.push(other.name);
      } else {
        const id='comp-audit-20261008-'+key;
        const p=patchComp(seed,key);
        await client.query(`INSERT INTO scenarios(id,name,color,params,results)
          VALUES($1,$2,$3,$4,NULL) ON CONFLICT(id) DO NOTHING`,
          [id,key.charAt(0).toUpperCase()+key.slice(1),COLORS[key],JSON.stringify(p)]);
        ids[id]=key;result.created.push({id,name:key});
      }
    }

    // If the currently selected saved case is clean, update its cached working
    // inputs as well. Otherwise respect the user's intentionally unsaved edits.
    if (state.activeScenarioId && ids[state.activeScenarioId] && !state.scenarioDirty && state.P) {
      const nextState={...state,P:patchComp(state.P,ids[state.activeScenarioId])};
      await client.query('UPDATE planner_state SET state=$1,updated_at=NOW() WHERE id=1',
        [JSON.stringify(nextState)]);
      result.activeCaseRefreshed=true;
    }

    await client.query('INSERT INTO planner_data_updates(id,details) VALUES($1,$2)',
      [UPDATE_ID,JSON.stringify(result)]);
    await client.query('COMMIT');
    return result;
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally {
    client.release();
  }
}
module.exports={UPDATE_ID,DATA,scenarioKey,patchComp,applyAuditedCompScenarios};
