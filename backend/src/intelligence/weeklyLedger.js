// Canonical weekly event ledger — the deterministic fix for the Weekly
// Review bug that reported "two nights of alcohol + late meals (Wed/Thu)"
// when there was only ONE overnight episode (Wednesday evening into early
// Thursday morning). Root cause: review.js's gatherWeek() read raw
// annotations one row per event and rendered each on its OWN calendar day
// ("Wednesday: alcohol", "Thursday: late_meal") with no notion that a
// post-midnight row belongs to the SAME night as the evening before it —
// inviting the LLM to read two calendar-day bullets as two separate nights.
//
// This module builds a small, deterministic ledger of EPISODES (one row per
// physical night/day) from the canonical Context Understanding Layer
// (context_assertions, retirement/negation/supersession-aware), with a
// conservative raw-annotation fallback for anything not yet compiled. The
// LLM never computes counts from prose — composeReview() renders straight
// from this ledger, and claimValidator's checkWeeklyEventCounts (see
// brain/claimValidator.js) validates generated text against it.
//
// General by design: episode grouping and concept-tagging apply uniformly
// to every concept/category — nothing here is alcohol- or late-meal-
// specific. Those two names only appear in the convenience aggregate
// fields the task explicitly asked for; the underlying mechanism
// (nightsByConcept, groupIntoEpisodes) works for any concept.
'use strict';

const { causeConceptTags, classifyEventKind, EVENT_KIND, isFinancialAnnotation } = require('./context-semantics');

// Matches analyze.js's resolveNightWindow ("night ending D" =
// [D-1 18:00 local, D wake-time-or-11am local)) — reusing the same
// evening-start/wake-fallback hours so "which night" means the same thing
// everywhere in this codebase, without requiring a per-day wake-time series
// (the weekly review doesn't gather one; the fallback hour is generous
// enough to still catch a same-morning report).
const EVENING_START_HOUR = 18;
const MORNING_END_HOUR = 11;

/** Pure: local calendar date (YYYY-MM-DD) and local hour (0-23) of `ts` in
 *  `tz`, via Intl — no wall-clock arithmetic of our own. */
function localParts(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  return { dateStr: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Pure: add `days` (may be negative) to a YYYY-MM-DD date string — plain
 *  calendar math via UTC, no timezone involved (the string already names a
 *  specific local calendar date). */
function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Pure: which "episode date" a timestamp belongs to. An early-morning
 * timestamp (before MORNING_END_HOUR local) is still part of the PREVIOUS
 * evening's episode — a 12:30am Thursday event belongs to "Wednesday
 * night", not a separate Thursday one. Everything else (daytime, evening)
 * is dated on its own calendar day. Applies uniformly to every
 * concept/category — there is no special-casing by event type here.
 */
function episodeDateFor(ts, tz) {
  const { dateStr, hour } = localParts(ts, tz);
  if (hour < MORNING_END_HOUR) return addDaysToDateStr(dateStr, -1);
  return dateStr;
}

/**
 * Pure: group a flat list of `{ id, concepts, label, timestamp, source }`
 * items into episode rows keyed by episodeDateFor(item.timestamp). Multiple
 * items landing on the same episode date (e.g. an 'alcohol' item at 11pm
 * and a 'late_meal' item at 12:30am the same continuous night) become ONE
 * row with the union of their concepts — this is the actual fix: the model
 * is handed one line per physical night, not one line per raw row.
 */
function groupIntoEpisodes(items, tz) {
  const byDate = new Map();
  for (const item of items || []) {
    if (!item || !item.timestamp) continue;
    const nightOf = episodeDateFor(item.timestamp, tz);
    if (!byDate.has(nightOf)) {
      byDate.set(nightOf, { nightOf, concepts: new Set(), assertionIds: new Set(), labels: new Set(), sources: new Set() });
    }
    const ep = byDate.get(nightOf);
    for (const c of item.concepts || []) if (c) ep.concepts.add(c);
    if (item.id) ep.assertionIds.add(item.id);
    if (item.label) ep.labels.add(item.label);
    if (item.source) ep.sources.add(item.source);
  }
  return Array.from(byDate.values())
    .map((ep) => ({
      nightOf: ep.nightOf,
      concepts: Array.from(ep.concepts).sort(),
      assertionIds: Array.from(ep.assertionIds),
      labels: Array.from(ep.labels),
      // 'assertion' = at least one item came from a compiled ContextAssertion
      // (higher confidence — structured, retirement/negation-aware);
      // 'annotation' = raw-fallback only; 'mixed' = both contributed.
      source: ep.sources.has('assertion') && ep.sources.has('annotation')
        ? 'mixed'
        : ep.sources.has('assertion') ? 'assertion' : 'annotation',
    }))
    .sort((a, b) => (a.nightOf < b.nightOf ? -1 : a.nightOf > b.nightOf ? 1 : 0));
}

/** Pure: how many episodes carry `concept`. */
function nightsWithConcept(episodes, concept) {
  return (episodes || []).filter((ep) => ep.concepts.includes(concept)).length;
}

/** Pure: how many episodes carry BOTH `conceptA` and `conceptB` — the exact
 *  shape of claim this bug's symptom made ("two nights of alcohol AND late
 *  meals"), computed generically (works for any concept pair). */
function nightsWithBothConcepts(episodes, conceptA, conceptB) {
  return (episodes || []).filter((ep) => ep.concepts.includes(conceptA) && ep.concepts.includes(conceptB)).length;
}

/** Pure: deterministic aggregates over a ledger's episodes. alcoholNights/
 *  lateMealNights/combinedNights are convenience fields (the exact names
 *  the task calls out) but are READ from the fully general nightsByConcept
 *  map / nightsWithBothConcepts — nothing about the underlying mechanism is
 *  alcohol- or late-meal-specific. */
function buildAggregates(episodes) {
  const eps = episodes || [];
  const nightsByConcept = {};
  for (const ep of eps) for (const c of ep.concepts) nightsByConcept[c] = (nightsByConcept[c] || 0) + 1;
  return {
    nightsByConcept,
    alcoholNights: nightsByConcept.alcohol || 0,
    lateMealNights: nightsByConcept.late_meal || 0,
    combinedNights: nightsWithBothConcepts(eps, 'alcohol', 'late_meal'),
    totalEpisodes: eps.length,
    supportedDates: eps.map((ep) => ep.nightOf),
  };
}

/** Pure: is this raw annotation eligible to become a ledger item at all —
 *  the "conservative raw fallback" gate (requirement: never count a
 *  retracted/negated/future/financial row as something that happened).
 *  Retirement itself is already excluded by annotationsStore.overlapping()'s
 *  own SQL before this ever runs. */
function isEligibleRawAnnotation(a) {
  const text = `${a.label || ''} ${a.note || ''}`;
  const kind = classifyEventKind(text, { category: a.category });
  if (kind === EVENT_KIND.RETRACTION || kind === EVENT_KIND.NEGATED || kind === EVENT_KIND.PLANNED) return false;
  if (isFinancialAnnotation(a)) return false;
  return true;
}

/**
 * Build the canonical weekly event ledger for [periodStart, periodEnd].
 * Structured path: compiled, concept-bearing ContextAssertions whose
 * effective window overlaps the period (retired/negated/retracted/
 * superseded already excluded by contextAssertions.getActiveOverlapping).
 * Raw fallback: annotations overlapping the period that do NOT already have
 * a compiled representation (deduped by sourceAnnotationId, so a row is
 * never counted through both paths at once — required test 5), filtered by
 * the same eligibility rule the rest of the codebase uses for "did this
 * actually happen" (context-semantics.classifyEventKind), with concepts
 * derived via the same causeConceptTags vocabulary claimValidator already
 * uses elsewhere, falling back to the annotation's own category so nothing
 * is silently dropped just because it names no recognized concept.
 */
/** Pure: project compiled, concept-bearing ContextAssertions into ledger
 *  items. Assertions with no concepts contribute nothing here (they don't
 *  carry classifiable tag info) — their source annotation, if any, is left
 *  free to be picked up by the raw fallback below instead of being silently
 *  dropped. */
function assertionsToItems(assertions) {
  return (assertions || [])
    .filter((a) => Array.isArray(a.concepts) && a.concepts.length)
    .map((a) => ({
      id: `assertion:${a.id}`,
      concepts: a.concepts,
      label: a.rawText || a.predicate || 'context',
      timestamp: a.effectiveStart || a.recordedAt,
      source: 'assertion',
      sourceAnnotationId: a.sourceAnnotationId,
    }));
}

/** Pure: the set of raw annotation ids already represented by a compiled
 *  assertion item — used to skip those in the raw fallback so a single
 *  underlying event is never counted through both paths at once
 *  (duplicate raw/compiled representations count once). */
function coveredAnnotationIdsFrom(assertionItems) {
  return new Set((assertionItems || []).map((i) => i.sourceAnnotationId).filter(Boolean));
}

/** Pure: raw annotations NOT already covered by a compiled assertion. */
function excludeCoveredAnnotations(rawAnnotations, coveredAnnotationIds) {
  return (rawAnnotations || []).filter((a) => !coveredAnnotationIds.has(a.id));
}

/** Pure: project eligible, uncovered raw annotations into ledger items,
 *  tagging concepts via the same causeConceptTags vocabulary claimValidator
 *  uses elsewhere, falling back to the annotation's own category so nothing
 *  is silently dropped just because it names no recognized concept. */
function rawAnnotationsToItems(rawAnnotations) {
  return (rawAnnotations || [])
    .filter(isEligibleRawAnnotation)
    .map((a) => {
      const text = `${a.label || ''} ${a.note || ''}`;
      const tags = causeConceptTags(text);
      return {
        id: `annotation:${a.id}`,
        concepts: tags.length ? tags : [String(a.category || 'context').toLowerCase()],
        label: a.label || a.category || 'context',
        timestamp: a.start_ts,
        source: 'annotation',
      };
    });
}

async function buildWeeklyLedger({ periodStart, periodEnd, tz = process.env.TZ || 'America/New_York' } = {}) {
  const contextAssertionsStore = require('../store/contextAssertions');
  const annotationsStore = require('../store/annotations');

  const assertions = await contextAssertionsStore.getActiveOverlapping(periodStart, periodEnd);
  const assertionItems = assertionsToItems(assertions);
  const coveredAnnotationIds = coveredAnnotationIdsFrom(assertionItems);

  const rawAnnotations = await annotationsStore.overlapping(periodStart, periodEnd);
  const rawItems = rawAnnotationsToItems(excludeCoveredAnnotations(rawAnnotations, coveredAnnotationIds));

  const episodes = groupIntoEpisodes([...assertionItems, ...rawItems], tz);
  return {
    periodStart, periodEnd, tz, episodes,
    ...buildAggregates(episodes),
  };
}

module.exports = {
  episodeDateFor, addDaysToDateStr, groupIntoEpisodes, buildAggregates,
  nightsWithConcept, nightsWithBothConcepts, isEligibleRawAnnotation,
  assertionsToItems, coveredAnnotationIdsFrom, excludeCoveredAnnotations, rawAnnotationsToItems,
  buildWeeklyLedger,
};
