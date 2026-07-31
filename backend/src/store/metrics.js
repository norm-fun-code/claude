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

  // This is the SINGLE write funnel every connector (Eight Sleep, Apple
  // Health, self-report, admin backfill) goes through — so it's the right
  // place to detect "a write just landed that can move the recovery score"
  // and drive the runtime invalidation bus from it, rather than only from the
  // POST /api/recovery/self-report route (which left the REAL ingestion path —
  // a normal overnight Eight Sleep sync — never bumping recovery_change at
  // all). Gated to the exact metric keys liveRecovery() reads, so an
  // unrelated write (wealth, wellbeing, a bulk historical backfill of some
  // other domain) doesn't pay for a recovery recompute it can't affect.
  try {
    const recoveryMod = require('../intelligence/recovery');
    const touchesRecovery = clean.some(
      (r) => r.domain === recoveryMod.RECOVERY_INPUT_DOMAIN && recoveryMod.RECOVERY_INPUT_METRICS.has(r.metric)
    );
    if (touchesRecovery) {
      const priorRecovery = await recoveryMod.liveRecovery().catch(() => null);
      recoveryMod.invalidateRecoveryCache();
      const freshRecovery = await recoveryMod.liveRecovery().catch(() => null);
      if (recoveryMod.recoveryMateriallyChanged(priorRecovery, freshRecovery)) {
        require('../brain/invalidation').bump('recovery_change', { source: 'ingest' });
      }
    }
  } catch (err) {
    console.error('[metrics] recovery invalidation check failed:', err.message);
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
// sources: optional allowlist (e.g. recovery.js's RECOVERY_SOURCE_LOCK) so a
// caller that needs "the latest OVERNIGHT HRV/RHR reading" specifically
// doesn't silently get a same-day-or-newer daytime Apple Watch row instead —
// the same source-distinctness every other recovery-comparable read in this
// codebase already enforces (truth-and-evidence contract, audit priority #1).
async function latest({ domain, metric, sources = null }) {
  const params = [domain, metric];
  let sourceClause = '';
  if (Array.isArray(sources) && sources.length) {
    params.push(sources);
    sourceClause = ` AND source = ANY($${params.length})`;
  }
  const { rows } = await query(
    `SELECT ts, value, unit, source, metadata
       FROM metrics
      WHERE domain = $1 AND metric = $2${sourceClause}
      ORDER BY ts DESC
      LIMIT 1`,
    params
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

/**
 * Resolve recent-vs-prior trends for many metrics with ONE bounded database
 * read. Ask used to call dailyAggregatePreferSource twice *serially* for each
 * tracked metric (up to 25), which meant an otherwise ordinary question could
 * spend dozens of database round trips assembling context before it even
 * reached the model. The query below reads the common 14-day window once;
 * JavaScript then applies the exact same per-day source-priority and
 * aggregation semantics as dailyAggregatePreferSource().
 *
 * This intentionally returns the average of the selected DAILY aggregates.
 * That is the historical Ask contract: for example, a daily steps `sum` is
 * averaged across days rather than summing fourteen days into one number.
 *
 * @param {Array<{domain:string, metric:string, agg?:'avg'|'min'|'max'|'sum', sources?:string[]|null}>} requests
 * @param {object} window
 * @param {Date|string} window.from start of the prior window (normally now-14d)
 * @param {Date|string} window.splitAt start of the recent window (normally now-7d)
 * @param {Date|string|null} [window.to] optional upper bound
 * @returns {Promise<Array<{domain:string, metric:string, recent:number|null, prior:number|null}>>}
 */
async function recentMetricTrends(requests, { from, splitAt, to = null, tz = process.env.TZ || 'America/New_York' } = {}) {
  const clean = (requests || [])
    .filter((r) => r?.domain && r?.metric)
    .map((r) => ({
      domain: String(r.domain),
      metric: String(r.metric),
      agg: ['avg', 'min', 'max', 'sum'].includes(r.agg) ? r.agg : 'avg',
      sources: Array.isArray(r.sources) && r.sources.length ? r.sources.map(String) : null,
    }));
  if (!clean.length) return [];

  // `requested` is parameterized arrays rather than a dynamically composed
  // VALUES list, so a metric name can never alter SQL. We calculate all four
  // allowed per-day aggregate functions together, then select the requested
  // one in JS. That keeps this one query while retaining catalog.aggFor()'s
  // per-metric choice.
  const { rows } = await query(
    `WITH requested AS (
       SELECT * FROM unnest($1::text[], $2::text[]) AS r(domain, metric)
     )
     SELECT date_trunc('day', m.ts AT TIME ZONE $6) AS day,
            m.domain, m.metric, m.source,
            CASE WHEN m.ts >= $4 THEN 'recent' ELSE 'prior' END AS period_bucket,
            avg(m.value) AS avg_value,
            min(m.value) AS min_value,
            max(m.value) AS max_value,
            sum(m.value) AS sum_value
      FROM metrics m
      JOIN requested r ON r.domain = m.domain AND r.metric = m.metric
      WHERE m.ts >= $3
        AND ($5::timestamptz IS NULL OR m.ts <= $5)
      GROUP BY day, m.domain, m.metric, m.source, period_bucket
      ORDER BY day ASC`,
    [clean.map((r) => r.domain), clean.map((r) => r.metric), from, splitAt, to, tz]
  );

  const byMetric = new Map();
  for (const row of rows) {
    const key = `${row.domain}\u0000${row.metric}`;
    const list = byMetric.get(key) || [];
    list.push(row);
    byMetric.set(key, list);
  }
  const priorityFor = (source) => {
    if (source === 'eight_sleep') return 1;
    if (source === 'apple_health') return 2;
    if (source === 'eight_sleep_baseline') return 3;
    return 4;
  };
  const avg = (values) => {
    const finite = values.map(Number).filter(Number.isFinite);
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
  };
  return clean.map((request) => {
    const allRows = byMetric.get(`${request.domain}\u0000${request.metric}`) || [];
    const perDay = new Map();
    for (const row of allRows) {
      if (request.sources && !request.sources.includes(row.source)) continue;
      // The boundary can fall mid-local-day. Keep the two request windows
      // separate here, exactly as the former pair of aggregate queries did.
      const dayKey = `${row.period_bucket}:${new Date(row.day).getTime()}`;
      const list = perDay.get(dayKey) || [];
      list.push(row);
      perDay.set(dayKey, list);
    }
    const recent = [];
    const prior = [];
    for (const sourceRows of perDay.values()) {
      const bestPriority = Math.min(...sourceRows.map((row) => priorityFor(row.source)));
      // Deliberately retain all same-priority sources, matching
      // dailyAggregatePreferSource's SQL join semantics exactly.
      const selected = sourceRows.filter((row) => priorityFor(row.source) === bestPriority);
      for (const row of selected) {
        const target = row.period_bucket === 'recent' ? recent : prior;
        target.push(row[`${request.agg}_value`]);
      }
    }
    return {
      domain: request.domain,
      metric: request.metric,
      recent: avg(recent),
      prior: avg(prior),
    };
  });
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

module.exports = { insertMetrics, getSeries, latest, dailyAggregate, dailyAggregatePreferSource, recentMetricTrends, listMetricKeys };
