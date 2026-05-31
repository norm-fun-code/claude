// Runs every registered connector, persisting metrics + documents to the spine.
// Use as a CLI (`npm run ingest`) on a schedule (cron / launchd), or call
// runIngest() from the server.
require('dotenv').config();
const { connectors } = require('../connectors');
const { insertMetrics } = require('../store/metrics');
const { upsertDocument } = require('../store/documents');
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

    const { metrics = [], documents = [], config } = (await c.sync(ctx)) || {};
    const written = await insertMetrics(metrics);
    let docs = 0;
    for (const doc of documents) {
      const id = await upsertDocument(doc);
      if (id) docs++;
    }
    // Persist any cursor/state the connector wants to remember for next run.
    if (config) await updateConfig(c.id, config);
    await markSync(c.id);
    return { id: c.id, metrics: written, documents: docs };
  } catch (err) {
    await markSync(c.id, { error: err.message });
    return { id: c.id, error: err.message };
  }
}

async function runIngest({ full = false } = {}) {
  const results = [];
  for (const c of connectors) {
    results.push(await runConnector(c, { full }));
  }
  return results;
}

module.exports = { runIngest, runConnector };

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
