// KnowledgeRelation registry — versioned, curated general knowledge about
// what plausibly affects what (e.g. "alcohol suppresses next-morning
// autonomic recovery"). This is the ONE place NormOS keeps facts that are
// true independent of any individual user's data — established physiology,
// not something NormOS has to rediscover from a personal correlation every
// time. Distinct from personal evidence (a confirmed self-experiment, an
// observed correlation), which lives in the `experiments` table and
// findings — see intelligence/context-resolver.js for how the two combine:
// established knowledge sets the EXPECTED direction/magnitude/window,
// personal evidence adjusts confidence and magnitude for THIS user, and
// neither is required for the other — a relation with no personal evidence
// still applies at its established (population-level) confidence, and a
// personal experiment with no established backing still counts, just at
// the weaker 'personal_experiment' tier.
//
// This registry migrates context-semantics.js's CAUSE_CONCEPTS (the flat
// {tag, regex} list used only to detect WHETHER text plausibly names a
// physiological cause) into structured relations that also say how strong,
// how long, and what language is justified — the missing piece that let a
// generated brief claim "the wine confirmed caused your low HRV" with no
// mechanism to distinguish that from "may be worth watching."
// context-semantics.js's causeConceptTags/CAUSE_CONCEPTS remain the
// deterministic TEXT-MATCHING layer (unchanged, still used for the
// existing recovery-driver eligibility gate) — this registry is the
// knowledge layer a compiled ContextAssertion's `concepts` are checked
// against to decide whether — and how confidently — a relation to a metric
// is justified.
'use strict';

const KNOWLEDGE_REGISTRY_VERSION = '1.0.0';

const EVIDENCE_TIER = Object.freeze({
  ESTABLISHED: 'established',                   // well-supported general relationship
  PERSONAL_EXPERIMENT: 'personal_experiment',    // confirmed N-of-1 self-experiment
  PERSONAL_OBSERVATION: 'personal_observation',  // an observed personal correlation only
  MODEL_HYPOTHESIS: 'model_hypothesis',          // proposed, not backed by either of the above
});

// Every entry mirrors the KnowledgeRelation shape from the design brief:
// sourceConcept, targetConcept, expectedDirection, evidenceTier,
// onsetHours/effectWindowHours/decayHalfLifeHours, qualifiers,
// authoritativeSources, allowedLanguage/prohibitedLanguage, version,
// reviewDate. `sourceConcept` matches context-semantics.js's CAUSE_CONCEPTS
// tags 1:1 so a compiled assertion's `concepts` (which the compiler
// constrains to that same vocabulary for health-domain assertions) can look
// itself up here directly — one shared vocabulary, not two that could drift.
const KNOWLEDGE_RELATIONS = [
  {
    id: 'alcohol_recovery_autonomic',
    sourceConcept: 'alcohol',
    targetConcept: 'health:recovery_autonomic', // overnight HRV/RHR-based autonomic recovery
    expectedDirection: 'negative',
    evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    onsetHours: 0,
    effectWindowHours: 24,
    decayHalfLifeHours: 10,
    qualifiers: ['dose-dependent', 'stronger the closer to bedtime'],
    authoritativeSources: ['established autonomic/HRV literature on evening alcohol intake'],
    allowedLanguage: ['is associated with', 'is a likely contributor to', 'commonly suppresses next-morning'],
    prohibitedLanguage: ['confirmed cause', 'proven to cause', 'guaranteed to'],
    version: '1.0.0',
    reviewDate: '2026-07-17',
  },
  {
    id: 'illness_recovery_autonomic',
    sourceConcept: 'illness',
    targetConcept: 'health:recovery_autonomic',
    expectedDirection: 'negative',
    evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    onsetHours: 0,
    effectWindowHours: 48,
    decayHalfLifeHours: 24,
    qualifiers: ['magnitude scales with severity', 'can persist into early recovery from illness'],
    authoritativeSources: ['established literature on acute illness/immune activation and HRV suppression'],
    allowedLanguage: ['is associated with', 'is a likely contributor to'],
    prohibitedLanguage: ['confirmed cause', 'proven to cause'],
    version: '1.0.0',
    reviewDate: '2026-07-17',
  },
  {
    id: 'travel_recovery_autonomic',
    sourceConcept: 'travel',
    targetConcept: 'health:recovery_autonomic',
    expectedDirection: 'negative',
    evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    onsetHours: 0,
    effectWindowHours: 48,
    decayHalfLifeHours: 24,
    qualifiers: ['stronger across multiple time zones', 'weaker for same-timezone travel'],
    authoritativeSources: ['established jet-lag/circadian-disruption literature'],
    allowedLanguage: ['is associated with', 'is a likely contributor to'],
    prohibitedLanguage: ['confirmed cause', 'proven to cause'],
    version: '1.0.0',
    reviewDate: '2026-07-17',
  },
  {
    id: 'room_conditions_sleep_quality',
    sourceConcept: 'room_conditions',
    targetConcept: 'health:sleep_quality',
    expectedDirection: 'negative',
    evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    onsetHours: 0,
    effectWindowHours: 12,
    decayHalfLifeHours: 6,
    qualifiers: ['thermal discomfort and noise both established sleep-quality disruptors'],
    authoritativeSources: ['established sleep-environment literature (thermal comfort, noise)'],
    allowedLanguage: ['is associated with', 'is a likely contributor to'],
    prohibitedLanguage: ['confirmed cause', 'proven to cause'],
    version: '1.0.0',
    reviewDate: '2026-07-17',
  },
  {
    id: 'late_meal_recovery_autonomic',
    sourceConcept: 'late_meal',
    targetConcept: 'health:recovery_autonomic',
    expectedDirection: 'negative',
    evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    onsetHours: 0,
    effectWindowHours: 12,
    decayHalfLifeHours: 6,
    qualifiers: ['effect is modest relative to alcohol/illness', 'more pronounced for large/heavy meals'],
    authoritativeSources: ['established literature on late/heavy food intake and overnight HRV'],
    allowedLanguage: ['is associated with', 'may be a modest contributor to'],
    prohibitedLanguage: ['confirmed cause', 'proven to cause', 'major cause'],
    version: '1.0.0',
    reviewDate: '2026-07-17',
  },
  {
    id: 'medication_recovery_autonomic',
    sourceConcept: 'medication',
    targetConcept: 'health:recovery_autonomic',
    expectedDirection: 'unknown',
    // Deliberately NOT 'established' — effect direction and magnitude vary
    // enormously by drug class (some suppress HRV, some have no autonomic
    // effect, a few improve it). A general "medication affects recovery"
    // relation would be too broad to be trustworthy; this stays visibly
    // uncertain until/unless a specific drug-level entry is added.
    evidenceTier: EVIDENCE_TIER.MODEL_HYPOTHESIS,
    onsetHours: null,
    effectWindowHours: 24,
    decayHalfLifeHours: null,
    qualifiers: ['effect direction and magnitude depend entirely on the specific medication'],
    authoritativeSources: [],
    allowedLanguage: ['may be worth watching', 'is a possible factor'],
    prohibitedLanguage: ['is associated with', 'confirmed cause', 'proven to cause', 'likely contributor'],
    version: '1.0.0',
    reviewDate: '2026-07-17',
  },
  {
    id: 'stress_recovery_autonomic',
    sourceConcept: 'stress',
    targetConcept: 'health:recovery_autonomic',
    expectedDirection: 'negative',
    evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    onsetHours: 0,
    effectWindowHours: 24,
    decayHalfLifeHours: 12,
    qualifiers: ['acute psychological stress is a well-established HRV suppressor'],
    authoritativeSources: ['established literature on acute stress/cortisol and HRV'],
    allowedLanguage: ['is associated with', 'is a likely contributor to'],
    prohibitedLanguage: ['confirmed cause', 'proven to cause'],
    version: '1.0.0',
    reviewDate: '2026-07-17',
  },
  {
    id: 'hard_training_recovery_autonomic',
    sourceConcept: 'hard_training',
    targetConcept: 'health:recovery_autonomic',
    expectedDirection: 'negative',
    evidenceTier: EVIDENCE_TIER.ESTABLISHED,
    onsetHours: 0,
    effectWindowHours: 36,
    decayHalfLifeHours: 18,
    qualifiers: ['dose-dependent on training load/intensity', 'well-documented in sports-science HRV literature'],
    authoritativeSources: ['established training-load/HRV sports-science literature'],
    allowedLanguage: ['is associated with', 'is a likely contributor to'],
    prohibitedLanguage: ['confirmed cause', 'proven to cause'],
    version: '1.0.0',
    reviewDate: '2026-07-17',
  },
];

/** All registry entries whose sourceConcept matches (case-insensitive). */
function knowledgeRelationsForConcept(sourceConcept) {
  const c = String(sourceConcept || '').toLowerCase();
  if (!c) return [];
  return KNOWLEDGE_RELATIONS.filter((r) => r.sourceConcept === c);
}

/** The single entry for an exact (sourceConcept, targetConcept) pair, or null. */
function findKnowledgeRelation(sourceConcept, targetConcept) {
  const c = String(sourceConcept || '').toLowerCase();
  const t = String(targetConcept || '');
  return KNOWLEDGE_RELATIONS.find((r) => r.sourceConcept === c && r.targetConcept === t) ?? null;
}

/** Every distinct targetConcept the registry knows about, for a given tier
 *  or above — mainly useful for tests/introspection. */
function allSourceConcepts() {
  return [...new Set(KNOWLEDGE_RELATIONS.map((r) => r.sourceConcept))];
}

module.exports = {
  KNOWLEDGE_REGISTRY_VERSION,
  EVIDENCE_TIER,
  KNOWLEDGE_RELATIONS,
  knowledgeRelationsForConcept,
  findKnowledgeRelation,
  allSourceConcepts,
};
