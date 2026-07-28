// Memory projection (product audit rec #6: separate conversation History
// from durable Memory) — the ONE read-side shape the Ask tab's "Memory"
// screen renders. Deliberately NOT a new truth model: every field here is
// derived from the SAME canonical stores/selectors the rest of the app
// already reasons from (context_assertions/context_relations via
// intelligence/context-resolver.js's isTemporallyEligible/isDurableAssertion,
// and the beliefs store's already-established display-status vocabulary —
// see routes/beliefs.js's displayStatus, which this mirrors on purpose so
// the SAME belief reads the same way on the Health tab's Patterns screen and
// here). This module only reshapes/categorizes already-fetched rows into a
// human-readable, UI-safe projection — no raw JSON, table names, policy
// enums, or internal scores ever reach the mobile layer through it.
//
// Pure where it matters (mirrors context-resolver.js's own discipline):
// buildMemoryProjection and every category/label helper below are
// synchronous, taking already-fetched rows, so the categorization/labeling
// logic is fully unit-testable without a database. See routes/memory.js for
// the thin async wrapper that fetches from the stores.
'use strict';

const {
  isTemporallyEligible, isDurableAssertion, isForwardEpisodic, describeAssertion,
} = require('./context-resolver');

// Confidence bar beliefs use to read as "supported" vs. a weaker
// "hypothesis" absent explicit user confirmation — kept identical to
// routes/beliefs.js's SUPPORTED_CONFIDENCE_MIN so a belief never reads
// differently on Health's Patterns screen than it does here.
const SUPPORTED_CONFIDENCE_MIN = 0.5;

// assertionType -> human Memory category. Checked in priority order (a
// correction/retraction reads as "Corrections & exclusions" regardless of
// what assertionType the compiler also assigned it) — see the category
// docstring below for why "People & relationships" has no dedicated
// assertionType of its own.
const CATEGORY = Object.freeze({
  PEOPLE: 'people_relationships',
  FACTS_PREFERENCES: 'stable_facts_preferences',
  ROUTINES: 'routines_classifications',
  GOALS: 'goals_projects',
  DECISIONS: 'decisions_commitments',
  EVENTS: 'time_bounded_events',
  CORRECTIONS: 'corrections_exclusions',
  BELIEFS: 'learned_beliefs',
});

const CATEGORY_LABEL = Object.freeze({
  [CATEGORY.PEOPLE]: 'People & relationships',
  [CATEGORY.FACTS_PREFERENCES]: 'Stable facts & preferences',
  [CATEGORY.ROUTINES]: 'Routines & recurring classifications',
  [CATEGORY.GOALS]: 'Goals & active projects',
  [CATEGORY.DECISIONS]: 'Decisions & commitments',
  [CATEGORY.EVENTS]: 'Time-bounded events',
  [CATEGORY.CORRECTIONS]: 'Corrections & exclusions',
  [CATEGORY.BELIEFS]: 'Learned preferences & beliefs',
});

// Best-effort "is this about a named person" signal, for the "People &
// relationships" filter chip ONLY — a UI convenience label, never a
// lifecycle/reasoning input (the underlying assertion is unaffected either
// way; this only changes which category chip surfaces it under). The
// compiler's own schema has no dedicated "this is about a person" field
// (see intelligence/context-compiler.js's COMPILE_JSON_SCHEMA), so this is
// a deliberately narrow, documented heuristic rather than an invented
// backend concept: a capitalized leading word/possessive in the subject,
// on an assertion with no more specific domain signal already claiming it.
const PERSON_SUBJECT_RE = /^[A-Z][a-z]+('s)?\b/;

function categorizeAssertion(a) {
  if (a.assertionType === 'correction' || ['negated', 'retracted', 'superseded'].includes(a.eventStatus)) {
    return CATEGORY.CORRECTIONS;
  }
  if (a.assertionType === 'classification') return CATEGORY.ROUTINES;
  if (a.assertionType === 'decision' || a.assertionType === 'completion') return CATEGORY.DECISIONS;
  if ((a.domains || []).includes('commitments')) return CATEGORY.DECISIONS;
  if ((a.domains || []).includes('goals')) return CATEGORY.GOALS;
  if (a.assertionType === 'plan') return CATEGORY.EVENTS;
  if (a.assertionType === 'preference') return CATEGORY.FACTS_PREFERENCES;
  if (a.assertionType === 'event') return CATEGORY.EVENTS;
  // 'state'/'explanation' — the two loosest types. A person-flavored subject
  // with no other domain claiming it reads as "People & relationships";
  // everything else defaults to "Stable facts" (the honest catch-all — see
  // module header on why there's no dedicated person detector).
  if ((!a.domains || !a.domains.length || (a.domains.length === 1 && a.domains[0] === 'other'))
    && PERSON_SUBJECT_RE.test(String(a.subject || ''))) {
    return CATEGORY.PEOPLE;
  }
  return CATEGORY.FACTS_PREFERENCES;
}

/** Mirrors routes/beliefs.js's displayStatus exactly — the belief's status
 *  vocabulary is already established for the Health tab's Patterns screen;
 *  Memory must show the SAME belief the SAME way, not invent a second
 *  reading of the same row. */
function beliefDisplayStatus(row) {
  if (row.status === 'retired') return 'retired';
  if (row.confirmed_at) return 'confirmed';
  return (row.confidence == null || row.confidence >= SUPPORTED_CONFIDENCE_MIN) ? 'supported' : 'hypothesis';
}

/** Human "why this exists" line — never the raw source/sourceAuthority enum
 *  itself, always a short reader-facing sentence fragment. */
function assertionProvenanceLabel(a) {
  if (a.sourceAuthority === 'device') return 'From a connected device';
  if (a.sourceAuthority === 'established_knowledge') return 'Established knowledge';
  if (a.sourceAuthority === 'personal_experiment') return 'Learned from a personal experiment';
  if (a.sourceAuthority === 'personal_observation') return 'Noticed from your data';
  if (a.sourceAuthority === 'model_hypothesis') return 'A hypothesis, not yet confirmed';
  return 'Stated by you';
}

function beliefProvenanceLabel(row) {
  if (row.confirmed_at) return 'Confirmed by you';
  if (row.kind === 'dismissal_pattern') return 'Noticed from a repeated pattern';
  if (row.kind === 'recommendation_outcome') return 'Learned from what worked';
  return 'Learned from what you said';
}

/** Compact "when does this apply" label — reuses the exact same eligibility
 *  facts context-resolver.js's isTemporallyEligible/isDurableAssertion
 *  already compute, just worded for a person instead of an LLM prompt. */
function assertionTemporalLabel(a, { asOf, tz }) {
  if (isDurableAssertion(a)) return 'Standing preference · no expiration';
  if (a.retiredAt) return 'Retired';
  if (!a.effectiveEnd) {
    return isForwardEpisodic(a) ? 'Open-ended — not currently reasoning-eligible' : '';
  }
  const { formatMonthDay } = require('../util/date');
  const endLabel = formatMonthDay(a.effectiveEnd, tz) || '';
  const eligible = isTemporallyEligible(a, { asOf, tz });
  if (!eligible) return endLabel ? `Ended ${endLabel} · expired event` : 'Expired';
  return endLabel ? `Ends ${endLabel}` : 'Time-bounded';
}

function assertionStatus(a, { asOf, tz, supersededByIds }) {
  if (a.retiredAt) return supersededByIds.has(a.id) ? 'superseded' : 'retracted';
  if (!isTemporallyEligible(a, { asOf, tz })) return 'expired';
  return 'active';
}

function assertionToMemoryItem(a, { asOf, tz, supersededByIds }) {
  const status = assertionStatus(a, { asOf, tz, supersededByIds });
  const eligibleForReasoning = status === 'active';
  return {
    id: `assertion:${a.id}`,
    origin: 'assertion',
    rawId: a.id,
    category: categorizeAssertion(a),
    statement: describeAssertion(a) || a.rawText,
    reason: assertionProvenanceLabel(a),
    observedAt: a.recordedAt,
    effectiveStart: a.effectiveStart,
    effectiveEnd: a.effectiveEnd,
    temporalLabel: assertionTemporalLabel(a, { asOf, tz }),
    status,
    confidence: a.confidence,
    eligibleForReasoning,
    supersedesId: a.supersedesAssertionId ? `assertion:${a.supersedesAssertionId}` : null,
    retiredReason: a.retiredAt ? a.retiredReason : null,
    actions: {
      canCorrect: !a.retiredAt,
      canForget: !a.retiredAt,
      canMarkTemporary: !a.retiredAt && isDurableAssertion(a),
      canConfirm: false, // no locking/confirmation authority exists for assertions today
      canViewSource: true,
    },
  };
}

function beliefToMemoryItem(row) {
  const status = beliefDisplayStatus(row);
  return {
    id: `belief:${row.id}`,
    origin: 'belief',
    rawId: row.id,
    category: CATEGORY.BELIEFS,
    statement: row.statement,
    reason: beliefProvenanceLabel(row),
    observedAt: row.created_at,
    effectiveStart: null,
    effectiveEnd: null,
    temporalLabel: status === 'confirmed' ? 'Confirmed by you' : '',
    status,
    confidence: row.confidence == null ? null : Number(row.confidence),
    eligibleForReasoning: row.status === 'active',
    supersedesId: null,
    retiredReason: status === 'retired' ? 'Retired' : null,
    actions: {
      canCorrect: status !== 'retired',
      canForget: status !== 'retired',
      canMarkTemporary: false, // beliefs have no effective-window concept
      canConfirm: status !== 'retired' && status !== 'confirmed',
      canViewSource: true,
    },
  };
}

/**
 * Build the Memory screen's full projection from already-fetched rows.
 * `assertions` = getActive() output (all currently non-retired rows,
 * eligible or not); `retiredAssertions` = getRecentlyRetired() output;
 * `beliefs` = listAll() output (active + retired, never forgotten).
 * Returns `{ active, historical }` — the exact split the UX spec asks for
 * ("a separate collapsed area for expired/superseded items").
 */
function buildMemoryProjection({ assertions = [], retiredAssertions = [], beliefs = [], asOf = new Date(), tz = 'America/New_York' } = {}) {
  const allAssertions = [...assertions, ...retiredAssertions];
  const supersededByIds = new Set(
    allAssertions.filter((a) => a.supersedesAssertionId).map((a) => a.supersedesAssertionId)
  );

  const assertionItems = allAssertions.map((a) => assertionToMemoryItem(a, { asOf, tz, supersededByIds }));
  const beliefItems = beliefs.map(beliefToMemoryItem);
  const all = [...assertionItems, ...beliefItems];

  const active = all.filter((i) => i.status === 'active' || i.status === 'confirmed' || i.status === 'supported' || i.status === 'hypothesis');
  const historical = all.filter((i) => !active.includes(i));

  const sortByRecency = (arr) => arr.slice().sort((a, b) => new Date(b.observedAt || 0) - new Date(a.observedAt || 0));

  return { active: sortByRecency(active), historical: sortByRecency(historical) };
}

module.exports = {
  CATEGORY, CATEGORY_LABEL,
  buildMemoryProjection,
  // Exposed for focused unit tests:
  categorizeAssertion, beliefDisplayStatus, assertionProvenanceLabel, beliefProvenanceLabel,
  assertionTemporalLabel, assertionStatus, assertionToMemoryItem, beliefToMemoryItem,
};
