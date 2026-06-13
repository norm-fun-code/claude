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

  // Dedup within-batch: last write wins per (ts, domain, metric, source).
  // Postgres throws "ON CONFLICT DO UPDATE command cannot affect row a second
  // time" when two rows in the same INSERT share the same conflict key.
  const deduped = [
    ...new Map(
      clean.map((r) => [`${r.ts ?? 'now'}\x00${r.domain}\x00${r.metric}\x00${r.source}`, r])
    ).values(),
  ];

  // Postgres bind-param limit is 65535; this INSERT uses 7 params/row.
  // Chunk at 5000 rows to stay safely under the cap for large payloads.
  const CHUNK = 5000;
  let written = 0;
  for (let offset = 0; offset < deduped.length; offset += CHUNK) {
    const chunk = deduped.slice(offset, offset + CHUNK);
    const values = [];
    const tuples = chunk.map((r, i) => {
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
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${chunk.length * 6 + i + 1})`;
    });
    // metadata params come last so each tuple can reference its own jsonb
    chunk.forEach((r) => values.push(r.metadata ?? {}));

    await query(
      `INSERT INTO metrics (ts, domain, metric, value, unit, source, metadata)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (ts, domain, metric, source) DO UPDATE
         SET value = EXCLUDED.value,
             unit = EXCLUDED.unit,
             -- Don't let an empty incoming metadata ({}) wipe richer metadata an
             -- earlier write stored; only overwrite when the new value has content.
             metadata = COALESCE(NULLIF(EXCLUDED.metadata, '{}'::jsonb), metrics.metadata)`,
      values
    );
    written += chunk.length;
  }
  return written;
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

/** Daily-bucketed aggregate for a metric (avg/min/max/sum), for trend math.
 *  excludeSource: skip rows from this source (e.g. 'seed') so demo data
 *  doesn't inflate real-data aggregates when both coexist. */
async function dailyAggregate({ domain, metric, from, to, agg = 'avg', excludeSource = null }) {
  const fn = ['avg', 'min', 'max', 'sum'].includes(agg) ? agg : 'avg';
  // date_trunc keeps this portable (works with or without TimescaleDB).
  const { rows } = await query(
    `SELECT date_trunc('day', ts) AS day, ${fn}(value) AS value
       FROM metrics
      WHERE domain = $1 AND metric = $2
        AND ($3::timestamptz IS NULL OR ts >= $3)
        AND ($4::timestamptz IS NULL OR ts <= $4)
        AND ($5::text IS NULL OR source != $5)
      GROUP BY day
      ORDER BY day ASC`,
    [domain, metric, from ?? null, to ?? null, excludeSource ?? null]
  );
  return rows;
}

/**
 * Like dailyAggregate but applies source priority per day, preventing double-
 * counting when multiple sources record the same metric (e.g. Apple Health
 * pulling Eight Sleep data via HealthKit).
 *
 * Priority order (lower = preferred):
 *   eight_sleep: 1  — manual daily entry, most accurate
 *   apple_health: 2  — device sync (may duplicate Eight Sleep via HealthKit)
 *   eight_sleep_baseline: 3 — historical averages, only used when no real data
 *   everything else: 4
 *
 * For each day, only the highest-priority source's rows are aggregated.
 */
async function dailyAggregatePreferSource({ domain, metric, from, to, agg = 'avg' }) {
  const fn = ['avg', 'min', 'max', 'sum'].includes(agg) ? agg : 'avg';
  const { rows } = await query(
    `WITH per_day_source AS (
       SELECT
         date_trunc('day', ts) AS day,
         source,
         ${fn}(value) AS value,
         CASE source
           WHEN 'eight_sleep'          THEN 1
           WHEN 'apple_health'         THEN 2
           WHEN 'eight_sleep_baseline' THEN 3
           ELSE 4
         END AS priority
       FROM metrics
      WHERE domain = $1 AND metric = $2
        AND ($3::timestamptz IS NULL OR ts >= $3)
        AND ($4::timestamptz IS NULL OR ts <= $4)
      GROUP BY day, source
     ),
     best_per_day AS (
       SELECT day, MIN(priority) AS best_priority
       FROM per_day_source
       GROUP BY day
     )
     SELECT p.day, p.value
     FROM per_day_source p
     JOIN best_per_day b ON p.day = b.day AND p.priority = b.best_priority
     ORDER BY p.day ASC`,
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

module.exports = { insertMetrics, getSeries, latest, dailyAggregate, dailyAggregatePreferSource, listMetricKeys };
