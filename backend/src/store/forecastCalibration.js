// Forecast-calibration ledger — see migrations/041_forecast_calibration.sql.
const { query } = require('../db');

/** Record one day's forecast-vs-actual comparison. Idempotent: the first
 *  comparison of the day wins (a rebuild later the same day is a no-op). */
async function record({ day, predictedBand, predictedScore, confidence, actualBand, actualScore }) {
  if (!day) throw new Error('day required');
  const hit = predictedBand != null && actualBand != null ? predictedBand === actualBand : null;
  await query(
    `INSERT INTO forecast_calibration (day, predicted_band, predicted_score, confidence, actual_band, actual_score, hit)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (day) DO NOTHING`,
    [day, predictedBand, predictedScore, confidence, actualBand, actualScore, hit]
  );
  return hit;
}

/** Rolling band-hit rate over the last `days`. { n, hits, rate } — rate null
 *  when there's nothing to rate yet. Fail-safe zeros on error so callers can
 *  treat "no ledger" and "empty ledger" identically. */
async function hitRate({ days = 30 } = {}) {
  try {
    const { rows } = await query(
      `SELECT count(*) FILTER (WHERE hit IS NOT NULL) AS n,
              count(*) FILTER (WHERE hit) AS hits
         FROM forecast_calibration
        WHERE day >= (now() - ($1 || ' days')::interval)::date`,
      [String(days)]
    );
    const n = Number(rows[0]?.n ?? 0);
    const hits = Number(rows[0]?.hits ?? 0);
    return { n, hits, rate: n > 0 ? hits / n : null };
  } catch {
    return { n: 0, hits: 0, rate: null };
  }
}

module.exports = { record, hitRate };
