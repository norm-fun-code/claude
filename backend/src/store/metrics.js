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
         SET value = CASE
               -- Cumulative daily metrics (steps, active energy, exercise/mindful
               -- minutes) only ever grow over a day. A morning sync reports a
               -- partial running total; without GREATEST it would clobber a
               -- complete count already stored (e.g. from the historical backfill
               -- or a later sync), collapsing daily totals to a partial figure.
               WHEN metrics.metric IN ('steps','active_energy','exercise_minutes','mindful_minutes')
                 THEN GREATEST(metrics.value, EXCLUDED.value)
               ELSE EXCLUDED.value
             END,
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
 *  doesn't inflate real-data aggregates when both coexist.
 *  tz: bucket by LOCAL calendar day, not the session/UTC day — an evening
 *  reading (e.g. 8pm ET = past midnight UTC) must land on the day it actually
 *  happened, or it silently doubles into the wrong day's total (see
 *  db/migrations/019's incident note: this exact gap once double-counted a
 *  day's steps in production). `AT TIME ZONE tz` converts to a naive local
 *  timestamp before truncating; node-postgres then hydrates that back as a
 *  Date whose toISOString() reproduces the correct local YYYY-MM-DD, which is
 *  exactly what every caller's day-key extraction already expects. */
async function dailyAggregate({ domain, metric, from, to, agg = 'avg', excludeSource = null, onlySource = null, tz = process.env.TZ || 'America/New_York' }) {
  const fn = ['avg', 'min', 'max', 'sum'].includes(agg) ? agg : 'avg';
  // excludeSource accepts a single source name (existing callers) or an array
  // (e.g. excluding both 'seed' and an additive-estimate source at once).
  const excludeArr = excludeSource == null ? null : Array.isArray(excludeSource) ? excludeSource : [excludeSource];
  const { rows } = await query(
    `SELECT date_trunc('day', ts AT TIME ZONE $7) AS day, ${fn}(value) AS value
       FROM metrics
      WHERE domain = $1 AND metric = $2
        AND ($3::timestamptz IS NULL OR ts >= $3)
        AND ($4::timestamptz IS NULL OR ts <= $4)
        AND ($5::text[] IS NULL OR NOT (source = ANY($5)))
        AND ($6::text IS NULL OR source = $6)
      GROUP BY day
      ORDER BY day ASC`,
    [domain, metric, from ?? null, to ?? null, excludeArr, onlySource ?? null, tz]
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
async function dailyAggregatePreferSource({ domain, metric, from, to, agg = 'avg', sources = null, tz = process.env.TZ || 'America/New_York' }) {
  const fn = ['avg', 'min', 'max', 'sum'].includes(agg) ? agg : 'avg';
  // Optional source allowlist: when provided, only these sources are considered.
  // Used by the recovery score to source-lock HRV/RHR to the manually-entered
  // Eight Sleep overnight numbers (+ seeded baseline), so daytime Apple Watch
  // readings never pollute the night-vs-night baseline comparison.
  //
  // Bucketed by LOCAL calendar day (AT TIME ZONE tz) — same reasoning as
  // dailyAggregate above: an evening reading must land on the day it
  // actually happened, not the UTC day.
  const { rows } = await query(
    `WITH per_day_source AS (
       SELECT
         date_trunc('day', ts AT TIME ZONE $6) AS day,
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
        AND ($5::text[] IS NULL OR source = ANY($5))
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
    [domain, metric, from ?? null, to ?? null, sources ?? null, tz]
  );
  return rows;
}

// listMetricKeys() has no WHERE clause — a full-table DISTINCT scan that gets
// slower forever as `metrics` grows, unlike every other query in this file
// (all bounded by a `ts >=` range on the indexed column). What it returns —
// the SET of distinct (domain, metric) pairs ever written — changes only
// when a genuinely new metric type is first ingested, essentially never
// during normal operation. Cache it for a few minutes rather than re-scanning
// the whole table on every analyze() run and every chat/ask request.
let _metricKeysCache = null;
let _metricKeysCacheAt = 0;
const METRIC_KEYS_CACHE_MS = Number(process.env.METRIC_KEYS_CACHE_MS) || 5 * 60 * 1000;

/** Distinct (domain, metric) pairs present in the spine. Cached briefly (see
 *  METRIC_KEYS_CACHE_MS) — safe because this set changes on the order of
 *  "a new metric type shipped," not per-request. */
async function listMetricKeys() {
  const now = Date.now();
  if (_metricKeysCache && now - _metricKeysCacheAt < METRIC_KEYS_CACHE_MS) return _metricKeysCache;
  const { rows } = await query(
    `SELECT DISTINCT domain, metric FROM metrics ORDER BY domain, metric`
  );
  _metricKeysCache = rows;
  _metricKeysCacheAt = now;
  return rows;
}

module.exports = { insertMetrics, getSeries, latest, dailyAggregate, dailyAggregatePreferSource, listMetricKeys };
