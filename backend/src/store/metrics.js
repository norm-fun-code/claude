// Read/write helpers for the canonical metrics spine.
const { query } = require('../db');

/**
 * Bulk-insert metric observations. Idempotent: re-ingesting the same
 * (ts, domain, metric, source) updates value/unit/metadata rather than erroring.
 *
 * @param {Array<{ts?: Date|string, domain: string, metric: string,
 *   value: number, unit?: string, source: string, metadata?: object}>} rows
 * @returns {Promise<number>} number of rows written
 */
async function insertMetrics(rows) {
  const clean = (rows || []).filter(
    (r) => r && r.domain && r.metric && r.source && Number.isFinite(Number(r.value))
  );
  if (clean.length === 0) return 0;

  // Build a single multi-row INSERT with positional params.
  const values = [];
  const tuples = clean.map((r, i) => {
    const b = i * 6;
    values.push(
      r.ts ? new Date(r.ts) : new Date(),
      r.domain,
      r.metric,
      Number(r.value),
      r.unit ?? null,
      r.source
    );
    // metadata is appended after all positional value params (see below)
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${clean.length * 6 + i + 1})`;
  });
  // metadata params come last so each tuple can reference its own jsonb
  clean.forEach((r) => values.push(r.metadata ?? {}));

  await query(
    `INSERT INTO metrics (ts, domain, metric, value, unit, source, metadata)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (ts, domain, metric, source) DO UPDATE
       SET value = EXCLUDED.value,
           unit = EXCLUDED.unit,
           metadata = EXCLUDED.metadata`,
    values
  );
  return clean.length;
}

/** Time-ordered series for a single metric over a window. */
async function getSeries({ domain, metric, from, to, limit = 1000 }) {
  const { rows } = await query(
    `SELECT ts, value, unit, source, metadata
       FROM metrics
      WHERE domain = $1 AND metric = $2
        AND ($3::timestamptz IS NULL OR ts >= $3)
        AND ($4::timestamptz IS NULL OR ts <= $4)
      ORDER BY ts ASC
      LIMIT $5`,
    [domain, metric, from ?? null, to ?? null, limit]
  );
  return rows;
}

/** Most recent value for a metric. */
async function latest({ domain, metric }) {
  const { rows } = await query(
    `SELECT ts, value, unit, source, metadata
       FROM metrics
      WHERE domain = $1 AND metric = $2
      ORDER BY ts DESC
      LIMIT 1`,
    [domain, metric]
  );
  return rows[0] ?? null;
}

/** Daily-bucketed aggregate for a metric (avg/min/max/sum), for trend math. */
async function dailyAggregate({ domain, metric, from, to, agg = 'avg' }) {
  const fn = ['avg', 'min', 'max', 'sum'].includes(agg) ? agg : 'avg';
  // date_trunc keeps this portable (works with or without TimescaleDB).
  const { rows } = await query(
    `SELECT date_trunc('day', ts) AS day, ${fn}(value) AS value
       FROM metrics
      WHERE domain = $1 AND metric = $2
        AND ($3::timestamptz IS NULL OR ts >= $3)
        AND ($4::timestamptz IS NULL OR ts <= $4)
      GROUP BY day
      ORDER BY day ASC`,
    [domain, metric, from ?? null, to ?? null]
  );
  return rows;
}

/** Distinct (domain, metric) pairs present in the spine. */
async function listMetricKeys() {
  const { rows } = await query(
    `SELECT DISTINCT domain, metric FROM metrics ORDER BY domain, metric`
  );
  return rows;
}

module.exports = { insertMetrics, getSeries, latest, dailyAggregate, listMetricKeys };
