// A dedicated read-only credential lets the family planner consume NormOS's
// existing account source without granting access to the rest of the life OS.
const express = require('express');
const crypto = require('crypto');
const { makeSnapshot } = require('../services/monarch-planner-snapshot');
function createPlannerAccountsRouter({
  db = require('../db'), api = require('../services/monarch-api'),
  env = process.env, now = Date.now,
  publish = require('../services/monarch-planner-snapshot').publishSnapshot,
} = {}) {
  const router = express.Router();
  let pending = null, retryAt = 0, lastFailure = null;
  const ttl = 5 * 60 * 1000;
  async function read() {
    const { rows } = await db.query("SELECT id, config FROM sources WHERE id IN ('monarch','monarch_api','monarch_mcp_sync')");
    let snapshot = rows.find(r=>r.id==='monarch')?.config?.plannerAccounts;
    if (!snapshot || !makeSnapshot(snapshot.accounts, {asOf:snapshot.asOf})) snapshot = null;
    const token = env.MONARCH_TOKEN || rows.find(r=>r.config?.monarchToken)?.config.monarchToken;
    let warning = now() < retryAt ? lastFailure : null;
    if ((!snapshot || now()-Date.parse(snapshot.asOf) >= ttl) && token && now() >= retryAt) {
      try {
        const accounts = await api.getAccounts(token);
        const next = makeSnapshot(accounts, {asOf:new Date(now()).toISOString()});
        if (!next) throw new Error('invalid_accounts; count=' + accounts.length + '; unnamed=' + accounts.filter(a=>!a.displayName&&!a.name).length + '; missingBalance=' + accounts.filter(a=>a.currentBalance==null).length);
        await db.query("INSERT INTO sources (id,domain,display_name) VALUES ('monarch','wealth','Monarch') ON CONFLICT (id) DO NOTHING");
        await publish(next);
        snapshot = next; lastFailure = null;
        console.info('[planner-bridge] account refresh succeeded; count=' + accounts.length);
      } catch (e) {
        const status = e.response?.status;
        warning = status === 401 ? 'Monarch session expired in NormOS.' : status === 429 ? 'Monarch is rate-limiting NormOS. Last-good balances retained.' : 'NormOS could not refresh Monarch accounts.';
        lastFailure = warning; retryAt = now() + ttl;
        const reason = String(e.message || e.code || 'unknown').split(token).join('[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0,400);
        console.warn('[planner-bridge] account refresh failed; status=' + (Number.isInteger(status) ? status : 'unavailable') + '; reason=' + reason);
      }
    }
    if (!snapshot) throw new Error(warning || 'Waiting for a successful Monarch account sync in NormOS.');
    return {...snapshot, warning, stale:now()-Date.parse(snapshot.asOf)>86400000};
  }
  router.get('/accounts', async (req,res) => {
    res.set('Cache-Control','no-store');
    const token = env.PLANNER_BRIDGE_TOKEN;
    if (!token) return res.status(503).json({error:'Planner connection is not configured.'});
    const a=Buffer.from(req.get('authorization')||''), b=Buffer.from(`Bearer ${token}`);
    if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return res.status(401).json({error:'unauthorized'});
    try {
      if(!pending)pending=read().finally(()=>{pending=null;});
      res.json(await pending);
    } catch(e) { res.status(503).json({error:e.message}); }
  });
  return router;
}
module.exports = {createPlannerAccountsRouter};
