// "What explains this?" — an optional context loop for meaningful anomaly
// cards. Generic across every metric/domain in intelligence/catalog.js — no
// metric- or phrase-specific special cases.
//
// Identity: intelligence/analyze.js's computeAnomalies stamps every anomaly
// finding's evidence with a deterministic `anomalyKey`
// (`anomaly:${metricKey}:${localObservationDate}`) — stable across
// analyze() reruns even though findings.id itself is destroyed and
// recreated every run (see store/findings.js's supersedeAuto). This module
// keys entirely off that anomalyKey, never off findings.id.
//
// Table: anomaly_context_questions (migration 067) is a narrow, purpose-
// built store — none of the three existing open-question mechanisms
// (answered_open_questions, signal_answers, open_question_instances) carry
// an answered/skipped tri-state plus the anomaly's own observed/baseline/
// unit snapshot, so extending one of them would have meant bolting an
// unrelated shape onto a table with different callers.
//
// Answer path reuses the SAME compiler/persistence/invalidation discipline
// every other context write uses (context-compiler.js's
// compileUserContext/persistCompiledContext, db.withTransaction,
// brain/invalidation's bumpDurable) — see intelligence/memory-mutations.js
// for the identical pattern. The one deliberate departure: every compiled
// assertion's effective window is forcibly overwritten to the anomaly's own
// local_observation_date (never the wording-inferred window) — the
// mechanism that satisfies "answering today must not make the event
// today's context."
'use strict';

const anomalyContextStore = require('../store/anomalyContext');
const contextAssertionsStore = require('../store/contextAssertions');
const { compileUserContext, persistCompiledContext } = require('./context-compiler');
const { localDayBoundsForYmd, localDateStr } = require('../util/date');

const DEFAULT_TZ = process.env.TZ || 'America/New_York';

/** An observation date is fresh enough to ask about only if it's today or
 *  yesterday in the user's local timezone — an older reading means the
 *  underlying data pipeline stalled or this is a backfilled/incomplete day,
 *  neither of which the user can meaningfully explain "what made the day
 *  different" for by the time they'd see the prompt. */
function isFreshEnough(localObservationDate, tz = DEFAULT_TZ, asOf = new Date()) {
  if (!localObservationDate) return false;
  const today = localDateStr(tz, asOf);
  const yesterday = localDateStr(tz, new Date(asOf.getTime() - 24 * 60 * 60 * 1000));
  return localObservationDate === today || localObservationDate === yesterday;
}

/** Pure eligibility gate. `row` is the anomaly_context_questions row (or
 *  null if none exists yet); `overlappingAssertions` is whatever
 *  contextAssertionsStore.getActiveOverlapping already returned for this
 *  observation day + domains. */
function isEligibleForQuestion({ evidence, row, overlappingAssertions = [], tz = DEFAULT_TZ, asOf = new Date() }) {
  if (!evidence || evidence.kind !== 'anomaly' || !evidence.anomalyKey) return false;
  if (!isFreshEnough(evidence.date, tz, asOf)) return false;
  // An active (non-retired) answered/skipped row means this exact anomaly
  // has already been asked about — do not ask again. A retired row
  // ("Forget") is fresh/re-askable, same as a brand-new anomaly.
  if (row && !row.retiredAt && (row.status === 'answered' || row.status === 'skipped')) return false;
  if (overlappingAssertions.length) return false;
  return true;
}

/** Human-facing card status — a forgotten (retired) row presents as fresh,
 *  never as its stale answered/skipped state. */
function cardStatus(row) {
  if (!row || row.retiredAt) return 'unanswered';
  return row.status;
}

async function fetchOverlapping(evidence, tz) {
  const bounds = localDayBoundsForYmd(tz, evidence.date);
  return contextAssertionsStore.getActiveOverlapping(bounds.start, bounds.end, {
    domains: Array.isArray(evidence.domains) && evidence.domains.length ? evidence.domains : null,
  });
}

/**
 * Idempotently create-or-fetch the question row for this anomaly and return
 * the card the mobile detail view renders. Called on-demand when the
 * detail view opens (not embedded in the cached briefing payload) — this
 * keeps the whole feature off the expensive full-briefing-rebuild path.
 */
async function ensureAnomalyContextCard({ metric, domains = [], evidence, tz = DEFAULT_TZ, now = new Date() }) {
  if (!evidence || evidence.kind !== 'anomaly' || !evidence.anomalyKey || !evidence.date) return null;

  const row = await anomalyContextStore.ensure({
    anomalyKey: evidence.anomalyKey,
    metric: metric || evidence.metric,
    domains,
    observedValue: evidence.latest ?? null,
    baselineMean: evidence.baselineMean ?? null,
    baselineStd: evidence.baselineStd ?? null,
    deviation: evidence.z ?? null,
    unit: evidence.unit ?? null,
    observedAt: localDayBoundsForYmd(tz, evidence.date).start,
    localObservationDate: evidence.date,
    tz,
    sourceFresh: isFreshEnough(evidence.date, tz, now),
  });

  const overlapping = row && !row.retiredAt && (row.status === 'answered' || row.status === 'skipped')
    ? [] // already-decided rows never need the overlap read
    : await fetchOverlapping({ ...evidence, domains }, tz);

  const eligible = isEligibleForQuestion({ evidence: { ...evidence, domains }, row, overlappingAssertions: overlapping, tz, asOf: now });

  return {
    anomalyKey: row.anomalyKey,
    metric: row.metric,
    domains: row.domains,
    observedValue: row.observedValue,
    baselineMean: row.baselineMean,
    unit: row.unit,
    localObservationDate: row.localObservationDate,
    status: cardStatus(row),
    eligible,
    rawAnswer: cardStatus(row) === 'answered' ? row.rawAnswer : null,
  };
}

/** First-answer or edit — one entrypoint for both, since editing simply
 *  re-answers an already-answered row. */
async function answerAnomalyContext({ anomalyKey, text, tz = DEFAULT_TZ, now = new Date() }) {
  const row = await anomalyContextStore.getByKey(anomalyKey);
  if (!row) return { ok: false, error: 'not_found' };

  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, error: 'text_required' };

  const recentActiveAssertions = await contextAssertionsStore
    .getActive({ recordedFrom: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) })
    .catch(() => []);
  const compiled = await compileUserContext({
    rawText: trimmed, source: 'anomaly_context', tz, now, recentActiveAssertions,
  });
  if (compiled.failed) return { ok: false, error: 'context_compilation_failed', failureType: compiled.failureType };

  // Forcibly bind every compiled assertion to the anomaly's OWN observation
  // date, discarding whatever temporalRef/explicitDate the compiler itself
  // guessed from the answer's wording — the anomaly already supplies the
  // authoritative date, so nothing here should be inferred from text.
  const bounds = localDayBoundsForYmd(row.tz || tz, row.localObservationDate);
  for (const a of compiled.assertions) {
    a.effectiveStart = bounds.start;
    a.effectiveEnd = bounds.end;
  }

  const { withTransaction } = require('../db');
  let newAssertionId = null;
  await withTransaction(async (client) => {
    const db = (queryText, params) => client.query(queryText, params);
    if (row.contextAssertionId) {
      await contextAssertionsStore.retire(row.contextAssertionId, 'replaced by a new anomaly-context answer', db);
    }
    if (compiled.assertions.length) {
      const persisted = await persistCompiledContext(compiled, { sourceAnnotationId: null, db });
      newAssertionId = persisted.assertionIds[0] ?? null;
    }
    await anomalyContextStore.recordAnswer(row.id, { rawAnswer: trimmed, contextAssertionId: newAssertionId }, db);
  });

  await require('../brain/invalidation').bumpDurable('context_assertion_change');
  return { ok: true, contextAssertionId: newAssertionId };
}

/** "Nothing unusual" — an explicit answer, but never compiled into
 *  structured context: this is the mechanism that guarantees it can never
 *  become a durable belief that something specific happened. Also retires
 *  any PRIOR linked explanation (editing away from a real answer back to
 *  "nothing unusual" must not leave a stale explanation active). */
async function markNothingUnusual({ anomalyKey }) {
  const row = await anomalyContextStore.getByKey(anomalyKey);
  if (!row) return { ok: false, error: 'not_found' };

  if (row.contextAssertionId) {
    await contextAssertionsStore.retire(row.contextAssertionId, 'replaced with nothing-unusual');
  }
  await anomalyContextStore.recordAnswer(row.id, { rawAnswer: 'Nothing unusual', contextAssertionId: null });
  if (row.contextAssertionId) await require('../brain/invalidation').bumpDurable('context_assertion_change');
  return { ok: true };
}

/** "Skip" — no explanation given, no compilation, nothing to invalidate.
 *  Persists so a rebuild or reopening the app doesn't re-ask. */
async function skipAnomalyContext({ anomalyKey }) {
  const row = await anomalyContextStore.getByKey(anomalyKey);
  if (!row) return { ok: false, error: 'not_found' };
  await anomalyContextStore.recordSkipped(row.id);
  return { ok: true };
}

/** "Forget" — retires the linked explanation (if any) via the existing
 *  context-assertion retirement semantics, and retires the question row
 *  itself so the eligibility gate treats it as fresh/re-askable again. */
async function forgetAnomalyContext({ anomalyKey }) {
  const row = await anomalyContextStore.getByKey(anomalyKey);
  if (!row) return { ok: false, error: 'not_found' };

  if (row.contextAssertionId) {
    await contextAssertionsStore.retire(row.contextAssertionId, 'forgotten by user');
  }
  await anomalyContextStore.retire(row.id, 'forgotten by user');
  if (row.contextAssertionId) await require('../brain/invalidation').bumpDurable('context_assertion_change');
  return { ok: true };
}

module.exports = {
  isFreshEnough,
  isEligibleForQuestion,
  ensureAnomalyContextCard,
  answerAnomalyContext,
  markNothingUnusual,
  skipAnomalyContext,
  forgetAnomalyContext,
};
