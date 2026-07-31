// Life-context annotations: travel, illness, deadlines, etc. — so the
// intelligence layer (and you) can explain anomalies instead of being misled.
const { query } = require('../db');
const { naiveToUtcIso } = require('../util/date');
const { classifyEventKind, EVENT_KIND, findRetractionTarget } = require('../intelligence/context-semantics');

const ET_TZ = 'America/New_York';

/** End-of-calendar-day (23:59:59.999) for TOMORROW in Eastern time. Annotations
 *  default to this so they're active all of today AND tomorrow morning —
 *  covering the next-day briefing that explains metrics affected by last
 *  night (e.g. low sleep after a late Knicks game). They're gone the day
 *  after that.
 *  Resolved explicitly via ET_TZ (not d.setDate()/setHours(), which are
 *  server-process-local and only correct if the OS-level TZ env var happens
 *  to match) — and via UTC calendar arithmetic for the +1 day so this can't
 *  land on the wrong date across a DST transition. */
function endOfTomorrowET(d = new Date()) {
  const [y, m, day] = d.toLocaleDateString('en-CA', { timeZone: ET_TZ }).split('-').map(Number);
  const tomorrowYmd = new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
  // Anchor the whole second, then add .999ms after conversion — naiveToUtcIso's
  // offset math loses sub-second precision when milliseconds are baked into
  // the input string.
  return new Date(new Date(naiveToUtcIso(`${tomorrowYmd}T23:59:59`, ET_TZ)).getTime() + 999);
}

/**
 * Create an annotation. When the text classifies as a RETRACTION (see
 * context-semantics.js — "forget that context", "ignore that", "didn't end
 * up going", etc.), this conservatively looks back a few days for the ONE
 * specific prior annotation it's unambiguously walking back and retires it
 * (retired_at set, row kept for audit — never deleted, see overlapping()
 * below for the exclusion side). The retraction row itself is always
 * inserted (for history), and is separately excluded from every consumer by
 * its own event-kind classification — retirement here is a best-effort
 * belt-and-suspenders step for the ORIGINAL claim, not what makes the
 * retraction itself non-causal.
 *
 * Returns `{ id, eventKind, retiredAnnotationId }` — `eventKind` lets
 * callers (e.g. the POST /briefing/context route) decide whether this
 * answer should also be copied into the day journal/beliefs pipeline as
 * ordinary life context (a retraction should not be).
 *
 * `db` defaults to the pooled `query` but accepts an injected transaction
 * client (see db/index.js's withTransaction) — a caller that needs this
 * write to succeed-or-fail ATOMICALLY together with another table's write
 * (e.g. POST /briefing/context's calendar_load signal_answers row — see
 * that route) passes the shared client through here instead of letting each
 * write commit independently.
 *
 * Transactional Brain Invalidation (audit recommendation #2): this store is
 * deliberately side-effect FREE with respect to brain/invalidation — it used
 * to call bump('annotation_retirement') itself the instant a row was
 * inserted, which, when called with an injected transaction client mid-
 * transaction, fired the invalidation BEFORE COMMIT. A rollback after that
 * point left the brain claiming state had changed when it hadn't. Every
 * caller is now the transaction owner and is responsible for invalidating
 * itself, strictly after its own transaction (if any) commits — see
 * routes/annotations.js and intelligence/context-input.js for the two
 * present patterns.
 */
async function createAnnotation(a, db = query) {
  const { startTs, endTs = null, category, label, note = null } = a;
  // Default end_ts to end-of-day ET so annotations expire automatically.
  // Callers can pass an explicit endTs for multi-day events (e.g. travel).
  const resolvedEndTs = endTs ?? endOfTomorrowET(new Date(startTs));
  const { rows } = await db(
    `INSERT INTO annotations (start_ts, end_ts, category, label, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [startTs, resolvedEndTs, category, label, note]
  );
  const id = rows[0]?.id ?? null;

  const text = `${label || ''} ${note || ''}`;
  const eventKind = classifyEventKind(text, { category });

  let retiredAnnotationId = null;
  if (id && eventKind === EVENT_KIND.RETRACTION) {
    try {
      // Search from the ACTUAL current time, not `startTs` — a retraction
      // answered to a "last night"/"yesterday"-phrased question has its own
      // start_ts backdated by the caller (see routes/annotations.js's
      // PAST_REFERRING_RE handling) so it's active over the right window for
      // OTHER purposes, but that backdating is unrelated to how far back a
      // retraction should search for what it's walking back — using it here
      // would make the lookback silently miss a same-day plan created after
      // the backdated timestamp.
      const now = new Date();
      const since = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const { rows: recent } = await db(
        `SELECT * FROM annotations
          WHERE id != $1 AND retired_at IS NULL
            AND start_ts >= $2 AND start_ts <= $3
          ORDER BY start_ts DESC
          LIMIT 20`,
        [id, since, now]
      );
      const target = findRetractionTarget(text, recent);
      if (target) {
        await retireAnnotation(target.id, 'superseded by a later retraction', db);
        retiredAnnotationId = target.id;
      }
    } catch (err) {
      console.error('[annotations] retraction target lookup failed:', err.message);
    }
  }

  return { id, eventKind, retiredAnnotationId };
}

/** Mark an annotation retired — excluded from every intelligence consumer
 *  (see overlapping() below) but never deleted, so history/audit views can
 *  still show it. Idempotent: a no-op if already retired. `db` accepts an
 *  injected transaction client, same as createAnnotation above. Does NOT
 *  invalidate itself — see createAnnotation's doc comment; the caller
 *  invalidates 'annotation_retirement' after its own transaction (if any)
 *  commits. */
async function retireAnnotation(id, reason = null, db = query) {
  const { rowCount } = await db(
    `UPDATE annotations SET retired_at = now(), retired_reason = $2 WHERE id = $1 AND retired_at IS NULL`,
    [id, reason]
  );
  return rowCount > 0;
}

async function listAnnotations({ from = null, to = null, limit = 100, category = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM annotations
      WHERE ($1::timestamptz IS NULL OR start_ts >= $1)
        AND ($2::timestamptz IS NULL OR start_ts <= $2)
        AND ($4::text IS NULL OR category = $4)
      ORDER BY start_ts DESC
      LIMIT $3`,
    [from, to, limit, category]
  );
  return rows;
}

/** Annotations overlapping a window — used to contextualize findings.
 *  Excludes retired/superseded annotations (see retireAnnotation above) —
 *  this is the single choke point that keeps a retracted or superseded
 *  annotation out of every intelligence consumer that calls this function
 *  (analyze.js, the briefing builders, watch.js, consolidate.js's
 *  self-model, relevant-highlight.js) without each having to re-check it. */
async function overlapping(windowStart, windowEnd) {
  const { rows } = await query(
    `SELECT * FROM annotations
      WHERE start_ts <= $2
        AND COALESCE(end_ts, start_ts) >= $1
        AND retired_at IS NULL
      ORDER BY start_ts DESC`,
    [windowStart, windowEnd]
  );
  return rows;
}

/**
 * Pure: build the `SET ... WHERE id = ...` clause + positional params for a
 * partial annotation edit, from whichever of {label, category} were actually
 * provided (undefined = "not sent, leave as-is" — distinct from an empty
 * string, which is rejected by the caller as an attempt to blank the label).
 * Split out so the SQL-building logic is unit-testable without a live DB.
 */
function buildAnnotationUpdate({ label, category, id }) {
  const sets = [];
  const params = [];
  if (label != null) { params.push(label.trim()); sets.push(`label = $${params.length}`); }
  if (category != null) { params.push(category); sets.push(`category = $${params.length}`); }
  if (!sets.length) return null; // nothing to update
  params.push(id);
  return { sql: `UPDATE annotations SET ${sets.join(', ')} WHERE id = $${params.length}`, params };
}

/** Edit an existing annotation's label and/or category IN PLACE (same row —
 *  every downstream reader queries annotations live, so a correction is
 *  visible on the very next read). Returns false if there was nothing to
 *  update. Does NOT invalidate itself — see createAnnotation's doc comment;
 *  the caller invalidates 'annotation_retirement' after this resolves. */
async function updateAnnotation(id, { label, category } = {}, db = query) {
  const built = buildAnnotationUpdate({ label, category, id });
  if (!built) return false;
  const guardedSql = built.sql.replace(/ WHERE id = /, ' WHERE retired_at IS NULL AND id = ');
  const { rowCount } = await db(guardedSql, built.params);
  return rowCount > 0;
}

async function getActiveById(id, db = query) {
  const { rows } = await db(`SELECT * FROM annotations WHERE id = $1 AND retired_at IS NULL`, [id]);
  return rows[0] ?? null;
}

module.exports = {
  createAnnotation, listAnnotations, overlapping, buildAnnotationUpdate, updateAnnotation, getActiveById,
  retireAnnotation, endOfTomorrowET,
};
