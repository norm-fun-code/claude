// EvidenceClaim v1 — the shared contract that says every piece of
// user-facing prose NormOS generates (Chief Brief, Evening Brief, Ask, and
// future surfaces) must be traceable to a canonical, versioned fact, and
// carries an explicit statement of how confidently it may be spoken.
//
// This module does NOT decide what's true — that's still BrainSnapshot's
// job (brain/snapshot.js's canonicalFacts/canonicalFactsFrom), the Context
// Understanding Layer's job (intelligence/context-resolver.js), and the
// store layer's job. buildEvidenceClaims() below is a thin, PURE projection
// of that already-canonical `facts` object into typed, individually
// checkable claim records — the same shape every surface can build its
// prompt guidance and post-generation validation from, so a fact can never
// quietly mean something different (or something more certain) on one
// surface than another.
//
// claimType and evidenceTier are deliberately reused vocabulary, not new
// invented enums: evidenceTier IS intelligence/knowledge-registry.js's
// EVIDENCE_TIER (established / supported_association / personal_experiment /
// personal_observation / model_hypothesis) — the same tiers a compiled
// ContextAssertion's driver relations already carry. A claim about a
// directly-known canonical value (today's recovery band, whether a goal is
// checked off) is tagged EVIDENCE_TIER.ESTABLISHED not because it's a
// population-level finding, but because "established" already means, in
// this codebase's vocabulary, the strongest tier — direct DB truth is at
// least that strong.
'use strict';

const { EVIDENCE_TIER } = require('../intelligence/knowledge-registry');

/** The kind of statement a claim represents. Mirrors the EvidenceClaim v1
 *  design brief verbatim — every claim built below (and every claim any
 *  future authority adds) must be exactly one of these. */
const CLAIM_TYPE = Object.freeze({
  FACT: 'fact',                         // a direct canonical value (recovery band, goal.achieved, spend total)
  OBSERVATION: 'observation',           // a personally-observed correlation (findings, self-model) — not causal
  ASSOCIATION: 'association',           // a knowledge-registry-backed physiological/behavioral pattern
  EXPERIMENT_RESULT: 'experiment_result', // a decided (confirmed/refuted) personal N-of-1 experiment
  RECOMMENDATION: 'recommendation',     // a suggested action — its rationale is a SEPARATE claim, never bundled
  HYPOTHESIS: 'hypothesis',             // proposed/running, not yet decided — must never read as settled
  UNKNOWN: 'unknown',                   // explicitly "we don't know" — the honest alternative to a guess
});

/** How assertively generated prose may state a claim. Three levels (not a
 *  continuum) so a validator can classify a sentence's phrasing pattern
 *  against exactly one of these, the same precision-first design as
 *  claimValidator.js's existing checks. */
const LANGUAGE_LEVEL = Object.freeze({
  ASSERTIVE: 'assertive',           // state as plain fact — "recovery is red today"
  HEDGED: 'hedged',                 // qualify uncertainty — "early to call", "worth watching"
  OBSERVATIONAL: 'observational',   // must be framed as a pattern/association, never proof — "tends to run higher on Zone 2 days"
  FORBIDDEN: 'forbidden',           // must not be stated as a claim of this kind at all — say "unknown" instead
});

/** Every claimType's default allowed language when the caller doesn't
 *  override it — encodes the exact rule the design brief states: causal
 *  language is blocked unless the evidence tier explicitly permits it, and
 *  in this registry the ONLY tier that ever does is a CONFIRMED personal
 *  experiment (see buildEvidenceClaims' experiment branch, which overrides
 *  this default to ASSERTIVE only in that one case). */
const DEFAULT_LANGUAGE_FOR_TYPE = Object.freeze({
  [CLAIM_TYPE.FACT]: LANGUAGE_LEVEL.ASSERTIVE,
  [CLAIM_TYPE.OBSERVATION]: LANGUAGE_LEVEL.OBSERVATIONAL,
  [CLAIM_TYPE.ASSOCIATION]: LANGUAGE_LEVEL.OBSERVATIONAL,
  [CLAIM_TYPE.EXPERIMENT_RESULT]: LANGUAGE_LEVEL.HEDGED, // overridden to ASSERTIVE only for a confirmed verdict
  [CLAIM_TYPE.RECOMMENDATION]: LANGUAGE_LEVEL.HEDGED,
  [CLAIM_TYPE.HYPOTHESIS]: LANGUAGE_LEVEL.FORBIDDEN,     // a running/proposed experiment may not be spoken as settled
  [CLAIM_TYPE.UNKNOWN]: LANGUAGE_LEVEL.FORBIDDEN,
});

let _seq = 0;
/** Deterministic-enough per-process claim id (not persisted, not a DB key —
 *  purely so a validator/log line can name WHICH claim a violation is
 *  about). Reset between snapshot builds is unnecessary: uniqueness within
 *  one buildEvidenceClaims() call is all any consumer needs. */
function nextClaimId(kind) {
  _seq = (_seq + 1) % 1_000_000;
  return `ec_${kind}_${_seq}`;
}

/**
 * Construct one well-formed EvidenceClaim. Every field the design brief
 * requires is represented; nothing here computes a NEW fact — every value
 * must already come from the caller's canonical `facts`/selector output.
 *
 * @param {object} opts
 * @param {string} [opts.claimId] - auto-generated from claimType if omitted.
 * @param {string|null} [opts.snapshotId]
 * @param {number|null} [opts.snapshotVersion]
 * @param {string} opts.claimType - one of CLAIM_TYPE.
 * @param {string} opts.subject - what the claim is about (e.g. 'recovery', 'goal:Valuation deck').
 * @param {string} opts.predicate - the relationship/property asserted (e.g. 'band', 'completed', 'cause').
 * @param {*} [opts.value] - the asserted value, or null for a pure UNKNOWN/negative claim.
 * @param {string[]} [opts.evidenceRefs] - canonical source keys (selector names, store ids) —
 *   never raw prose; see buildEvidenceClaims for the actual refs used.
 * @param {string|null} [opts.observedFrom] - ISO start of the window the claim is valid for.
 * @param {string|null} [opts.observedTo] - ISO end of that window.
 * @param {string} [opts.evidenceTier] - one of EVIDENCE_TIER; defaults to MODEL_HYPOTHESIS (weakest).
 * @param {number|null} [opts.confidence] - 0-1, when meaningful.
 * @param {string} [opts.allowedLanguage] - one of LANGUAGE_LEVEL; defaults from claimType.
 * @param {string|null} [opts.expiresAt] - ISO timestamp after which this claim is stale.
 * @param {string|null} [opts.supersededBy] - another claimId, when a correction replaced this one.
 * @returns {object} frozen EvidenceClaim.
 */
function makeClaim({
  claimId = null,
  snapshotId = null,
  snapshotVersion = null,
  claimType,
  subject,
  predicate,
  value = null,
  evidenceRefs = [],
  observedFrom = null,
  observedTo = null,
  evidenceTier = EVIDENCE_TIER.MODEL_HYPOTHESIS,
  confidence = null,
  allowedLanguage = null,
  expiresAt = null,
  supersededBy = null,
} = {}) {
  if (!claimType || !Object.values(CLAIM_TYPE).includes(claimType)) {
    throw new Error(`makeClaim: invalid claimType "${claimType}"`);
  }
  if (!subject || !predicate) {
    throw new Error('makeClaim: subject and predicate are required');
  }
  return Object.freeze({
    claimId: claimId || nextClaimId(claimType),
    snapshotId,
    snapshotVersion,
    claimType,
    subject,
    predicate,
    value,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    observedFrom,
    observedTo,
    evidenceTier,
    confidence,
    allowedLanguage: allowedLanguage || DEFAULT_LANGUAGE_FOR_TYPE[claimType] || LANGUAGE_LEVEL.HEDGED,
    expiresAt,
    supersededBy,
  });
}

/**
 * Build the full EvidenceClaim packet from a canonical `facts` object — the
 * SAME shape brain/snapshot.js's canonicalFactsFrom/canonicalFacts already
 * produce (recoveryBand/Score, effectiveWorkout*, goals, commitments,
 * experiments, spendingTotalMonth, forecastGrade/tomorrowBand, localDate,
 * recoveryDrivers, resolvedContext). Pure and deterministic: calling this
 * twice on the same facts produces claims with the same content (claimIds
 * differ only because the counter is per-process, never persisted or
 * compared).
 *
 * Every claim's evidenceRefs names the authoritative SELECTOR or store the
 * value came from (registry.js's `authority` strings where applicable) —
 * never a prose string, never self_model text, never a raw journal entry,
 * never a prior briefing. This is what satisfies the design brief's "build
 * claims only from canonical authorities" requirement: this function has no
 * access to anything BUT the facts object, which is itself only ever built
 * from BrainSnapshot/ResolvedContext/store selectors (see snapshot.js).
 *
 * @param {object} facts - canonicalFactsFrom()-shaped object.
 * @param {{ snapshotId?: string|null, snapshotVersion?: number|null }} [meta]
 * @returns {object[]} array of EvidenceClaim.
 */
function buildEvidenceClaims(facts, meta = {}) {
  if (!facts) return [];
  const { snapshotId = null, snapshotVersion = null } = meta;
  const base = { snapshotId, snapshotVersion };
  const claims = [];

  // ── Recovery ────────────────────────────────────────────────────────────
  if (facts.recoveryBand) {
    claims.push(makeClaim({
      ...base, claimType: CLAIM_TYPE.FACT, subject: 'recovery', predicate: 'band',
      value: facts.recoveryBand, evidenceRefs: ['intelligence/recovery.liveRecovery'],
      evidenceTier: EVIDENCE_TIER.ESTABLISHED,
      confidence: facts.recoveryProxy ? 0.5 : 0.9,
    }));
  }
  if (facts.recoveryScore != null) {
    claims.push(makeClaim({
      ...base, claimType: CLAIM_TYPE.FACT, subject: 'recovery', predicate: 'score',
      value: facts.recoveryScore, evidenceRefs: ['intelligence/recovery.liveRecovery'],
      evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    }));
  }
  // Recovery CAUSE is the one place a FACT-tier subject (recovery) pairs with
  // ASSOCIATION-tier claims about what's driving it — every eligible driver
  // is its own claim, OBSERVATIONAL language only (never "causes"/"drives"),
  // matching the knowledge registry's own allowedLanguage lists (none of
  // which include causal wording — see knowledge-registry.js). Absent any
  // eligible driver, the honest claim is UNKNOWN, not silence — a validator
  // checking "is there a claim licensing this cause?" must find NOTHING to
  // license one, rather than nothing to check at all.
  if (Array.isArray(facts.recoveryDrivers) && facts.recoveryDrivers.length) {
    for (const driver of facts.recoveryDrivers) {
      claims.push(makeClaim({
        ...base, claimType: CLAIM_TYPE.ASSOCIATION, subject: 'recovery', predicate: 'contributingFactor',
        value: driver, evidenceRefs: ['intelligence/recovery-drivers', 'intelligence/knowledge-registry'],
        evidenceTier: EVIDENCE_TIER.SUPPORTED_ASSOCIATION,
      }));
    }
  } else if (facts.recoveryBand || facts.recoveryScore != null) {
    claims.push(makeClaim({
      ...base, claimType: CLAIM_TYPE.UNKNOWN, subject: 'recovery', predicate: 'cause', value: null,
      evidenceRefs: ['intelligence/recovery-drivers'],
    }));
  }

  // ── Effective workout (override/auto-downgrade/scheduled) ─────────────────
  if (facts.effectiveWorkoutLabel) {
    claims.push(makeClaim({
      ...base, claimType: CLAIM_TYPE.FACT, subject: 'workout', predicate: 'effectivePlan',
      value: { label: facts.effectiveWorkoutLabel, source: facts.effectiveWorkoutSource },
      evidenceRefs: ['services/workout.getEffectiveWorkout'],
      evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    }));
  }

  // ── Goal / commitment completion ───────────────────────────────────────
  for (const g of facts.goals || []) {
    if (!g?.text) continue;
    claims.push(makeClaim({
      ...base, claimType: CLAIM_TYPE.FACT, subject: `goal:${g.text}`, predicate: 'completed',
      value: g.achieved === true, evidenceRefs: ['store/goals.listGoals', 'store/intentions.currentIntention'],
      evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    }));
  }
  for (const c of facts.commitments || []) {
    if (!c?.title) continue;
    const completed = c.status === 'completed' || c.status === 'done';
    claims.push(makeClaim({
      ...base, claimType: CLAIM_TYPE.FACT, subject: `commitment:${c.title}`, predicate: 'completed',
      value: completed, evidenceRefs: ['store/commitments.listActive'],
      evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    }));
  }

  // ── Spending ────────────────────────────────────────────────────────────
  if (facts.spendingTotalMonth != null) {
    claims.push(makeClaim({
      ...base, claimType: CLAIM_TYPE.FACT, subject: 'wealth', predicate: 'spendingMonthToDate',
      value: facts.spendingTotalMonth, evidenceRefs: ['brain/snapshot.canonicalSpendingMtd'],
      evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    }));
  }

  // ── Forecast ────────────────────────────────────────────────────────────
  if (facts.forecastGrade) {
    claims.push(makeClaim({
      ...base, claimType: CLAIM_TYPE.FACT, subject: 'forecast', predicate: 'todayGrade',
      value: facts.forecastGrade, evidenceRefs: ['intelligence/predict.computeTodayForecast'],
      evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    }));
  }
  if (facts.tomorrowBand) {
    claims.push(makeClaim({
      ...base, claimType: CLAIM_TYPE.FACT, subject: 'forecast', predicate: 'tomorrowBand',
      value: facts.tomorrowBand, evidenceRefs: ['intelligence/predict.computeTodayForecast'],
      evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    }));
  }

  // ── Current date ────────────────────────────────────────────────────────
  if (facts.localDate) {
    claims.push(makeClaim({
      ...base, claimType: CLAIM_TYPE.FACT, subject: 'calendar', predicate: 'localDate',
      value: facts.localDate, evidenceRefs: ['brain/snapshot.buildBrainSnapshot'],
      evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    }));
  }

  // ── Experiments (decided vs still running) ─────────────────────────────
  for (const e of facts.experiments || []) {
    if (!e?.hypothesis) continue;
    const confirmed = e.verdict === 'confirmed';
    claims.push(makeClaim({
      ...base,
      claimType: confirmed ? CLAIM_TYPE.EXPERIMENT_RESULT : CLAIM_TYPE.HYPOTHESIS,
      subject: `experiment:${e.hypothesis}`, predicate: 'verdict', value: e.verdict ?? e.status ?? null,
      evidenceRefs: ['store/experiments.listExperiments'],
      evidenceTier: confirmed ? EVIDENCE_TIER.PERSONAL_EXPERIMENT : EVIDENCE_TIER.MODEL_HYPOTHESIS,
      // The ONE case in this whole registry where assertive/causal-flavored
      // language ("worked", "confirmed") is licensed — a completed, confirmed
      // N-of-1 experiment on THIS exact relationship. Every other experiment
      // state (running, refuted, inconclusive) stays FORBIDDEN from being
      // spoken as settled (see DEFAULT_LANGUAGE_FOR_TYPE).
      allowedLanguage: confirmed ? LANGUAGE_LEVEL.ASSERTIVE : LANGUAGE_LEVEL.FORBIDDEN,
    }));
  }

  // ── Context Understanding Layer: negated/retracted + expiring assertions ──
  // Each compiled ContextAssertion becomes its own FACT claim about its
  // eventStatus — this is what lets a validator catch prose that cites a
  // negated/retracted event as if it happened, and is also where the
  // "optional expiry/superseded state" field earns its keep: a resolver
  // assertion past its own effectiveEnd is claimed with expiresAt set, so a
  // validator (or a future renderer) can treat it as stale without
  // re-deriving that from raw timestamps itself.
  const resolved = facts.resolvedContext;
  if (resolved && Array.isArray(resolved.assertions)) {
    for (const a of resolved.assertions) {
      if (!a) continue;
      const probe = a.predicate ? `${a.predicate} ${a.objectValue || ''}`.trim() : a.rawText;
      if (!probe) continue;
      claims.push(makeClaim({
        ...base, claimType: CLAIM_TYPE.FACT, subject: `assertion:${a.id ?? probe}`, predicate: 'eventStatus',
        value: a.eventStatus ?? 'occurred', evidenceRefs: ['intelligence/context-resolver.resolveContext', `context_assertions:${a.id ?? 'n/a'}`],
        evidenceTier: EVIDENCE_TIER.ESTABLISHED, // user_explicit — the strongest evidence this layer carries
        observedFrom: a.effectiveStart ?? null, observedTo: a.effectiveEnd ?? null,
        expiresAt: a.effectiveEnd ?? null,
        supersededBy: a.eventStatus === 'retracted' ? (a.supersededByAssertionId ?? null) : null,
      }));
    }
  }

  return claims;
}

/** Pure: has `claim` passed its own expiresAt (or been marked supersededBy
 *  another claim)? Every surface that consults facts.claims can call this
 *  identically — the SAME answer regardless of which surface asks, which is
 *  the whole point of carrying expiresAt/supersededBy on the claim itself
 *  rather than letting each surface re-derive staleness from raw
 *  timestamps its own way. */
function isClaimStale(claim, asOf = new Date()) {
  if (!claim) return false;
  if (claim.supersededBy) return true;
  if (claim.expiresAt && new Date(claim.expiresAt).getTime() < asOf.getTime()) return true;
  return false;
}

/** Compact, non-sensitive projection of a claims array for provenance/debug
 *  metadata (design brief item 7) — claimId/claimType/evidenceTier/
 *  allowedLanguage only, NEVER the claim's `value` (which can carry health,
 *  finance, or personal-context content) or evidenceRefs' store ids beyond
 *  the bare selector name. Intended for a server response's debug-only
 *  field or a log line, never for the normal UI. */
function summarizeClaimsForDebug(claims) {
  return (claims || []).map((c) => ({
    claimId: c.claimId,
    claimType: c.claimType,
    evidenceTier: c.evidenceTier,
    allowedLanguage: c.allowedLanguage,
  }));
}

module.exports = {
  CLAIM_TYPE,
  LANGUAGE_LEVEL,
  EVIDENCE_TIER, // re-exported so a consumer needs only ONE require for both vocabularies
  makeClaim,
  buildEvidenceClaims,
  isClaimStale,
  summarizeClaimsForDebug,
};
