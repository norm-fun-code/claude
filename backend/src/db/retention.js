// Metrics retention for vanilla Postgres (no TimescaleDB) — see the
// engineering review's #7 and src/db/migrations/039_metrics_retention.sql's
// header for the Timescale-compression side of this.
//
// Deliberately NOT wired into the scheduler or run automatically anywhere —
// this is a personal health/wealth diary; there's no generically "safe" age
// past which a user's own data stops mattering to them, so deleting
// anything is a deliberate, manual decision, not a background job. This
// module exists so that decision — if/when actual row count ever warrants
// it — is a tested, reviewed one-liner instead of an ad-hoc DELETE typed
// into psql under pressure.
//
// In practice: every writer in src/ingest/*.js anchors `ts` to one
// timestamp per calendar day (see src/util/date.js's dayAnchorTs — a
// deliberate fix so repeated syncs update the same row instead of each
// creating a new one), so metrics accumulates at roughly
// (distinct domain+metric pairs) × (days) rows — for this app's ~30-50
// metrics, that's on the order of 10-50K rows/year. Confirmed via EXPLAIN
// ANALYZE against 500K synthetic rows (~decades of headroom at that rate)
// that idx_metrics_domain_metric_ts (domain, metric, ts DESC) — which
// matches every read in src/store/metrics.js: WHERE domain=? AND metric=?
// [AND ts range] ORDER BY ts — is used correctly (Bitmap/Index Scan, never
// a sequential scan) with sub-millisecond execution at that scale. This
// isn't an urgent problem; it's infrastructure kept ready for later.
const { pool, query } = require('./index');

/**
 * Read-only: how many rows (and their date range) would be affected by
 * purging metrics older than `olderThanDays`. Always safe to call.
 */
async function previewOldMetrics({ olderThanDays }) {
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    throw new Error('olderThanDays must be a positive number');
  }
  const { rows } = await query(
    `SELECT count(*)::int AS n, min(ts) AS oldest, max(ts) AS newest
       FROM metrics
      WHERE ts < now() - ($1 || ' days')::interval`,
    [olderThanDays]
  );
  return rows[0];
}

/**
 * Deletes metrics rows older than `olderThanDays`. Requires confirm:true —
 * calling this without it throws rather than silently no-op-ing, so a
 * script can never delete real data by forgetting a flag.
 *
 * @returns {Promise<{deleted: number}>}
 */
async function purgeMetricsOlderThan({ olderThanDays, confirm = false }) {
  if (!confirm) {
    throw new Error('purgeMetricsOlderThan requires confirm:true — this permanently deletes rows.');
  }
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    throw new Error('olderThanDays must be a positive number');
  }
  const { rowCount } = await query(
    `DELETE FROM metrics WHERE ts < now() - ($1 || ' days')::interval`,
    [olderThanDays]
  );
  return { deleted: rowCount };
}

module.exports = { previewOldMetrics, purgeMetricsOlderThan };

// CLI: node src/db/retention.js --days=3650 [--confirm]
// Defaults to a dry-run preview; --confirm actually deletes. No default
// day cutoff — you must name one, so this can never be run "by habit."
if (require.main === module) {
  require('dotenv').config();
  const args = process.argv.slice(2);
  const daysArg = args.find((a) => a.startsWith('--days='));
  const confirm = args.includes('--confirm');
  const olderThanDays = daysArg ? Number(daysArg.split('=')[1]) : NaN;

  (async () => {
    if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
      console.error('Usage: node src/db/retention.js --days=<N> [--confirm]');
      console.error('  Previews (or, with --confirm, deletes) metrics rows older than N days.');
      process.exitCode = 1;
      return;
    }
    if (!confirm) {
      const preview = await previewOldMetrics({ olderThanDays });
      console.log(
        `Preview (dry run — pass --confirm to actually delete): ${preview.n} row(s) older than ` +
        `${olderThanDays} days would be deleted` +
        (preview.n > 0 ? ` (range: ${preview.oldest?.toISOString()} to ${preview.newest?.toISOString()})` : '') + '.'
      );
      return;
    }
    const result = await purgeMetricsOlderThan({ olderThanDays, confirm: true });
    console.log(`Deleted ${result.deleted} row(s) older than ${olderThanDays} days.`);
  })()
    .catch((err) => { console.error('retention failed:', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
