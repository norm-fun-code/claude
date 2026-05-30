// Source registry helpers.
const { query } = require('../db');

/** Idempotently register (or update the descriptor of) a data source. */
async function registerSource({ id, domain, displayName, config = {} }) {
  await query(
    `INSERT INTO sources (id, domain, display_name, config)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET domain = EXCLUDED.domain,
           display_name = EXCLUDED.display_name,
           config = sources.config || EXCLUDED.config`,
    [id, domain, displayName, config]
  );
}

/** Record the outcome of a sync run. */
async function markSync(id, { error = null } = {}) {
  await query(
    `UPDATE sources
        SET last_sync_at = now(),
            status = $2,
            last_error = $3
      WHERE id = $1`,
    [id, error ? 'error' : 'active', error]
  );
}

async function getSource(id) {
  const { rows } = await query('SELECT * FROM sources WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Shallow-merge a patch into a source's JSONB config (e.g. sync cursors). */
async function updateConfig(id, patch) {
  await query(
    `UPDATE sources SET config = config || $2 WHERE id = $1`,
    [id, patch || {}]
  );
}

async function listSources() {
  const { rows } = await query('SELECT * FROM sources ORDER BY domain, id');
  return rows;
}

module.exports = { registerSource, markSync, getSource, updateConfig, listSources };
