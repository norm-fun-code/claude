// Recommendation ledger — persistence for leverage actions surfaced to the user.
const { query } = require('../db');

/**
 * Collapse a recommendation title to its number-independent shape so that
 * "Best sleep nights → 13% better HRV" and "… 12% better HRV" dedupe to one
 * recommendation. The previous prefix-match dedup failed because the number
 * lives in the MIDDLE of the title. Strips numbers + their attached units (%,
 * ms, bpm, h, pts, /5, …) to a placeholder, leaving the semantic words intact.
 */
function normalizeRecTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[+\-]?\d[\d,]*(\.\d+)?\s*(%|ms|bpm|hrs?|hours?|pts?|mins?|days?|x|h|\/\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

async function recordRecommendation({
  type = 'leverage',
  findingId = null,
  title,
  detail = null,
  lever = null,
  outcomeMetric = null,
  expectedDirection = null,
  score = null,
  surfacedIn = 'briefing',
}) {
  const { rows } = await query(
    `INSERT INTO recommendations
       (type, finding_id, title, detail, lever, outcome_metric, expected_direction, score, surfaced_in)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [type, findingId, title, detail, lever, outcomeMetric, expectedDirection, score != null ? +score.toFixed(4) : null, surfacedIn]
  );
  return rows[0]?.id;
}

/** Returns recommendations ordered newest-first. */
async function listRecommendations({ limit = 50, since = null, outcomeMetric = null } = {}) {
  const params = [limit];
  const clauses = [];
  if (since) clauses.push(`created_at >= $${params.push(since)}`);
  if (outcomeMetric) clauses.push(`outcome_metric = $${params.push(outcomeMetric)}`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM recommendations ${where} ORDER BY created_at DESC LIMIT $1`,
    params
  );
  return rows;
}

/**
 * Store the measured outcome for a recommendation.
 * delta: actual change in outcome_metric over the 7 days following the recommendation.
 */
async function setOutcome(id, { delta, measuredAt = new Date() }) {
  await query(
    `UPDATE recommendations SET outcome_delta = $2, outcome_measured_at = $3 WHERE id = $1`,
    [id, delta != null ? +Number(delta).toFixed(4) : null, measuredAt]
  );
}

/**
 * Returns the set of recommendation titles surfaced in briefings within the
 * last `withinDays` days — used to avoid logging identical duplicates every day.
 */
async function recentTitles(withinDays = 3) {
  const { rows } = await query(
    `SELECT title FROM recommendations
     WHERE surfaced_in = 'briefing'
       AND created_at >= now() - ($1 || ' days')::interval`,
    [withinDays]
  );
  return new Set(rows.map((r) => r.title));
}

/**
 * All recommendation titles (any source) within the last `withinDays` days —
 * used by the chat path for cross-source deduplication.
 */
async function recentTitlesAll(withinDays = 7) {
  const { rows } = await query(
    `SELECT title FROM recommendations WHERE created_at >= now() - ($1 || ' days')::interval`,
    [withinDays]
  );
  return new Set(rows.map((r) => r.title));
}

/**
 * For recommendations surfaced in the last `lookbackDays` that have an
 * outcome_metric, compute the 7-day delta from metrics and write it back.
 * Called on Sunday morning from the weekly review flow.
 */
async function measureOutcomes(lookbackDays = 10) {
  const metricsStore = require('./metrics');
  const { rows } = await query(
    `SELECT id, outcome_metric, expected_direction, created_at
     FROM recommendations
     WHERE outcome_metric IS NOT NULL
       AND outcome_measured_at IS NULL
       AND created_at >= now() - ($1 || ' days')::interval`,
    [lookbackDays]
  );

  let measured = 0;
  for (const rec of rows) {
    try {
      const [domain, metric] = rec.outcome_metric.split(':');
      if (!domain || !metric) continue;
      const recDate = new Date(rec.created_at);
      // Before window: 7 days ending on rec date. After window: 7 days after.
      const beforeStart = new Date(recDate.getTime() - 7 * 864e5);
      const afterEnd = new Date(recDate.getTime() + 7 * 864e5);
      const [before, after] = await Promise.all([
        metricsStore.dailyAggregate({ domain, metric, from: beforeStart, to: recDate, agg: 'avg' }),
        metricsStore.dailyAggregate({ domain, metric, from: recDate, to: afterEnd, agg: 'avg' }),
      ]);
      const avg = (rows) => rows.length ? rows.reduce((s, r) => s + Number(r.value), 0) / rows.length : null;
      const beforeVal = avg(before);
      const afterVal = avg(after);
      if (beforeVal == null || afterVal == null || before.length < 3 || after.length < 3) continue;
      await setOutcome(rec.id, { delta: afterVal - beforeVal, measuredAt: new Date() });
      measured++;
    } catch {
      // Skip silently — don't break the whole review run
    }
  }
  return measured;
}

/**
 * Collapse already-stored near-duplicate PENDING recommendations (no user
 * feedback yet) that differ only by the numbers in their title, keeping the most
 * recent. Rows the user has rated (outcome_measured_at set) are never touched, so
 * no feedback is lost. Returns the count removed. Safe to call on boot.
 */
async function dedupePending() {
  const { rows } = await query(
    `SELECT id, title FROM recommendations
      WHERE outcome_measured_at IS NULL
      ORDER BY created_at DESC, id DESC`
  );
  const seen = new Set();
  const toDelete = [];
  for (const r of rows) {
    const key = normalizeRecTitle(r.title);
    if (seen.has(key)) toDelete.push(r.id);
    else seen.add(key);
  }
  if (toDelete.length) {
    await query(`DELETE FROM recommendations WHERE id = ANY($1::int[])`, [toDelete]);
  }
  return toDelete.length;
}

module.exports = { recordRecommendation, listRecommendations, setOutcome, recentTitles, recentTitlesAll, measureOutcomes, normalizeRecTitle, dedupePending };
