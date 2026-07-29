// Runs every registered connector, persisting metrics + documents to the spine.
// Use as a CLI (`npm run ingest`) on a schedule (cron / launchd), or call
// runIngest() from the server.
require('dotenv').config();
const { connectors } = require('../connectors');
const { insertMetrics } = require('../store/metrics');
const { upsertDocument, pruneDocuments } = require('../store/documents');
const { registerSource, markSync, getSource, updateConfig } = require('../store/sources');

async function runConnector(c, { full = false } = {}) {
  await registerSource({ id: c.id, domain: c.domain, displayName: c.displayName });
  try {
    // Give the connector its prior state for incremental syncs. `full` forces a
    // complete re-sync by hiding the last-sync timestamp.
    const source = await getSource(c.id);
    const ctx = {
      lastSyncAt: full ? null : (source?.last_sync_at ?? null),
      config: source?.config ?? {},
    };

    const { metrics = [], documents = [], config, reconcile, coverage } = (await c.sync(ctx)) || {};
    const written = await insertMetrics(metrics);
    let docs = 0;
    for (const doc of documents) {
      const id = await upsertDocument(doc);
      if (id) docs++;
    }
    // Reconcile the synced window: prune stored docs the source no longer reports
    // there (deleted, or moved to another month). Runs AFTER the upserts so the
    // fresh set is already persisted and only stale rows are removed.
    let pruned = 0;
    if (reconcile) pruned = await pruneDocuments(reconcile);
    // Wealth matched-pace hardening pass: a connector that just attested
    // real coverage for a date range (Monarch's CSV/MCP sync — see
    // coverage's own doc comments) has that range merged into the source's
    // tracked coverage intervals (services/coverageIntervals.js), read by
    // discretionarySpend.js to gate historical-month eligibility on PROVEN
    // coverage rather than "there's a document somewhere before this date".
    if (coverage?.from && coverage?.to) {
      try {
        const { addInterval } = require('../services/coverageIntervals');
        const src = await getSource(coverage.source || c.id);
        const merged = addInterval(src?.config?.coverageIntervals, coverage.from, coverage.to);
        await updateConfig(coverage.source || c.id, { coverageIntervals: merged });
      } catch (err) {
        console.error(`[ingest] ${c.id} coverage-interval update failed:`, err.message);
      }
    }
    // Persist any cursor/state the connector wants to remember for next run.
    if (config) await updateConfig(c.id, config);
    await markSync(c.id);
    return { id: c.id, metrics: written, documents: docs, pruned };
  } catch (err) {
    await markSync(c.id, { error: err.message });
    return { id: c.id, error: err.message };
  }
}

// Post-ingest detectors: after a domain's data lands, run its same-day
// detector so a reaction is EVENT-DRIVEN (like health's runWatch on health
// ingest), not just polled on a fixed schedule. Fire-and-forget — the ingest
// return value must not wait on (or be failed by) a detector — and every
// candidate still routes through the Attention Policy's dispatch, which since
// the atomic-delivery rework (migration 045) safely dedups a post-ingest
// trigger racing the scheduled backstop, so this can't double-notify.
//
// NOTE (watcher architecture — PHASE ONE): this is a small per-connector map,
// not yet the fully general post-ingest event bus + field TTL registry +
// mid-day briefing addendum described in docs/watcher-architecture.md. Health
// (routes/health.js) and wellbeing (routes/checkin.js) still wire their own
// detectors inline at their write sites; wealth is wired here. Generalizing all
// three onto one hook is the documented next step.
const POST_INGEST_DETECTORS = {
  // Monarch wrote fresh wealth data -> run the wealth watch immediately instead
  // of waiting for the 1pm/5pm poll (which stays as a backstop in scheduler.js).
  monarch_mcp_sync: (result) => {
    if (result.error || !(result.metrics > 0)) return;
    require('../intelligence/wealth-nudges').runWealthNudges({})
      .then((r) => { if (r?.sent) console.log(`[ingest] post-monarch wealth watch: sent=${r.sent}`); })
      .catch((e) => console.error('[ingest] post-monarch wealth watch failed:', e.message));
  },
};

async function runIngest({ full = false, only = null } = {}) {
  const list = only ? connectors.filter((c) => c.id === only) : connectors;
  const results = [];
  for (const c of list) {
    const result = await runConnector(c, { full });
    results.push(result);
    const detector = POST_INGEST_DETECTORS[result.id];
    if (detector) { try { detector(result); } catch (e) { console.error('[ingest] post-ingest detector error:', e.message); } }
  }
  return results;
}

module.exports = { runIngest, runConnector, POST_INGEST_DETECTORS };

// CLI entrypoint
if (require.main === module) {
  const { pool } = require('../db');
  runIngest()
    .then((results) => {
      for (const r of results) {
        if (r.error) console.log(`✗ ${r.id}: ${r.error}`);
        else console.log(`✓ ${r.id}: ${r.metrics} metrics, ${r.documents} documents`);
      }
    })
    .catch((err) => {
      console.error('Ingest failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
