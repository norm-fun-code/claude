// CRUD for self-experiments (the hypothesis loop).
const { query } = require('../db');

async function createExperiment(e) {
  const {
    hypothesis,
    metric,
    lever = null,
    expected = 'up',
    protocol = null,
    startDate = null,
    endDate = null,
    baselineDays = 14,
    status = 'proposed',
    sourceFinding = null,
  } = e;

  const { rows } = await query(
    `INSERT INTO experiments
       (hypothesis, metric, lever, expected, protocol, start_date, end_date, baseline_days, status, source_finding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (hypothesis) DO NOTHING
     RETURNING id`,
    [hypothesis, metric, lever, expected, protocol, startDate, endDate, baselineDays, status, sourceFinding]
  );
  return rows[0]?.id ?? null;
}

async function listExperiments({ status = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM experiments
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC`,
    [status]
  );
  return rows;
}

async function getExperiment(id) {
  const { rows } = await query('SELECT * FROM experiments WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function updateExperiment(id, fields) {
  const sets = [];
  const vals = [id];
  const map = {
    status: 'status',
    verdict: 'verdict',
    result: 'result',
    startDate: 'start_date',
    endDate: 'end_date',
    protocol: 'protocol',
    pausedAt: 'paused_at',
  };
  for (const [k, col] of Object.entries(map)) {
    if (fields[k] !== undefined) {
      vals.push(fields[k]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (!sets.length) return;
  await query(`UPDATE experiments SET ${sets.join(', ')} WHERE id = $1`, vals);
}

async function cancelExperimentsByMetricDomain(domain) {
  await query(
    `UPDATE experiments SET status = 'cancelled'
      WHERE status IN ('proposed','running') AND metric LIKE $1`,
    [`${domain}:%`]
  );
}

/** Cancel ALL proposed/running experiments — clears the slate before re-proposing. */
async function cancelAllActiveExperiments() {
  await query(`UPDATE experiments SET status = 'cancelled' WHERE status IN ('proposed', 'running')`);
}

module.exports = { createExperiment, listExperiments, getExperiment, updateExperiment, cancelExperimentsByMetricDomain, cancelAllActiveExperiments };
