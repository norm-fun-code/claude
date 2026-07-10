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

// Every recommendation gets a linked commitment — it's the one surface a
// recommendation shows up on (see the notification/insight-taxonomy review:
// a single leverage rec used to spread across up to 5 places). For a
// metric-less rec, the commitment IS the only way to close the loop
// (measureOutcomes only looks at rows WHERE outcome_metric IS NOT NULL, so
// without this it would sit "Pending" forever). For a metric-bearing rec, the
// commitment is how the insight surfaces to the user at all now that there's
// no separate ledger card — done/skipped just acknowledges it; the REAL
// verdict still comes from the 7-day metric delta (see commitments.js's
// recordAdherenceOutcome, which skips writing an adherence outcome for these).
const FOLLOWUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  dedupKey = null,
  commitmentSource = 'brief',
}) {
  const { rows } = await query(
    `INSERT INTO recommendations
       (type, finding_id, title, detail, lever, outcome_metric, expected_direction, score, surfaced_in, dedup_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [type, findingId, title, detail, lever, outcomeMetric, expectedDirection, score != null ? +score.toFixed(4) : null, surfacedIn, dedupKey]
  );
  const id = rows[0]?.id;
  if (id) {
    require('./commitments').create({
      title: String(title).slice(0, 200),
      detail,
      source: commitmentSource,
      dueAt: new Date(Date.now() + FOLLOWUP_WINDOW_MS),
      recommendationId: id,
    }).catch((e) => console.error('[recommendations] auto-commit failed:', e.message));
  }
  return id;
}

/** Minimal lookup for commitments.js's recordAdherenceOutcome — just enough
 *  to decide whether a linked commitment's done/skip tap should write an
 *  adherence outcome (only for metric-less recs; see FOLLOWUP_WINDOW_MS's
 *  comment above). */
async function getById(id) {
  const { rows } = await query(`SELECT id, outcome_metric FROM recommendations WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Returns recommendations ordered newest-first, each carrying its linked
 * commitment's status/due date if one was auto-created (see recordRecommendation)
 * — so a caller (the ledger UI) can tell "this resolves itself when you finish
 * the linked task on Today" apart from "this is waiting on your rating."
 */
async function listRecommendations({ limit = 50, since = null, outcomeMetric = null } = {}) {
  const params = [limit];
  const clauses = [];
  if (since) clauses.push(`r.created_at >= $${params.push(since)}`);
  if (outcomeMetric) clauses.push(`r.outcome_metric = $${params.push(outcomeMetric)}`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT r.*, c.status AS commitment_status, c.due_at AS commitment_due_at
       FROM recommendations r
       LEFT JOIN commitments c ON c.recommendation_id = r.id
       ${where}
      ORDER BY r.created_at DESC LIMIT $1`,
    params
  );
  return rows;
}

/**
 * The last leverage action surfaced in a PRIOR day's briefing (before `beforeDate`,
 * normally today's local midnight) — so the chief-of-staff brief can follow up on
 * it ("yesterday I said X — did it happen?") instead of only ever suggesting new
 * actions and never checking back in.
 */
async function mostRecentLeverageAction(beforeDate) {
  const { rows } = await query(
    `SELECT * FROM recommendations
      WHERE type = 'leverage' AND surfaced_in = 'briefing' AND created_at < $1
      ORDER BY created_at DESC LIMIT 1`,
    [beforeDate]
  );
  return rows[0] ?? null;
}

/**
 * Store the measured outcome for a recommendation. First verdict wins: a
 * recommendation can be resolved through more than one path (a manual
 * thumbs-up/down, an auto-measured metric delta, or a linked commitment's
 * done/skipped cascade) — once one has written an outcome, a later call is a
 * no-op rather than silently overwriting it.
 * delta: actual change in outcome_metric over the 7 days following the recommendation.
 */
async function setOutcome(id, { delta, measuredAt = new Date() }) {
  const { rowCount } = await query(
    `UPDATE recommendations SET outcome_delta = $2, outcome_measured_at = $3
      WHERE id = $1 AND outcome_measured_at IS NULL`,
    [id, delta != null ? +Number(delta).toFixed(4) : null, measuredAt]
  );
  return rowCount > 0;
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
 * Returns the set of non-null dedup_keys surfaced in briefings within the last
 * `withinDays` days. dedup_key identifies a finding's BASIS (kind + lever/
 * outcome/metric/…), so it survives title copy changes — unlike normalizeRecTitle,
 * which only survives number changes and misses a full rewording of the same insight.
 */
async function recentDedupKeys(withinDays = 7) {
  const { rows } = await query(
    `SELECT dedup_key FROM recommendations
     WHERE surfaced_in = 'briefing'
       AND dedup_key IS NOT NULL
       AND created_at >= now() - ($1 || ' days')::interval`,
    [withinDays]
  );
  return new Set(rows.map((r) => r.dedup_key));
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
// Auto-measurement only fires once a recommendation has had a real chance to
// land: at least MIN_ELAPSED_DAYS of calendar time AND MIN_AFTER_DAYS of actual
// follow-up readings. Before that the verdict would be a 2-3 day blip of noise,
// so the row stays "Measuring…" rather than being prematurely called "No effect".
const MIN_ELAPSED_DAYS = 7;
const MIN_AFTER_DAYS = 5;

async function measureOutcomes(lookbackDays = 21) {
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
      // Don't judge until the recommendation has had time to take effect.
      if ((Date.now() - recDate.getTime()) / 864e5 < MIN_ELAPSED_DAYS) continue;
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
      if (beforeVal == null || afterVal == null || before.length < 3 || after.length < MIN_AFTER_DAYS) continue;
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
    `SELECT id, title, dedup_key FROM recommendations
      WHERE outcome_measured_at IS NULL
      ORDER BY created_at DESC, id DESC`
  );
  const seen = new Set();
  const toDelete = [];
  for (const r of rows) {
    // Prefer dedup_key (survives title rewording); fall back to the fuzzy
    // number-normalized title for older rows / chat recs that have none.
    const key = r.dedup_key || `title:${normalizeRecTitle(r.title)}`;
    if (seen.has(key)) toDelete.push(r.id);
    else seen.add(key);
  }
  if (toDelete.length) {
    await query(`DELETE FROM recommendations WHERE id = ANY($1::int[])`, [toDelete]);
  }
  return toDelete.length;
}

/**
 * One-time repair: clear outcomes that were AUTO-measured before a recommendation
 * had MIN_ELAPSED_DAYS to take effect (the old engine judged after ~3 days, so
 * short-window noise got stamped "No effect"). User thumbs are preserved — those
 * write an exact ±1 delta, which an auto-measurement (a raw metric difference)
 * effectively never produces. Cleared rows return to "Measuring…" and get
 * re-judged once a real window of data is in. Safe to call on boot.
 */
async function clearPrematureAutoOutcomes() {
  const { rowCount } = await query(
    `UPDATE recommendations
        SET outcome_delta = NULL, outcome_measured_at = NULL
      WHERE outcome_measured_at IS NOT NULL
        AND outcome_delta IS NOT NULL
        AND abs(outcome_delta) <> 1
        AND outcome_measured_at < created_at + ($1 || ' days')::interval`,
    [String(MIN_ELAPSED_DAYS)]
  );
  return rowCount;
}

module.exports = { recordRecommendation, listRecommendations, setOutcome, recentTitles, recentDedupKeys, recentTitlesAll, measureOutcomes, normalizeRecTitle, dedupePending, clearPrematureAutoOutcomes, mostRecentLeverageAction, getById };
