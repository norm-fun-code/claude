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
// the weaker 'personal_experiment' tier. EVERY entry below is
// POPULATION-level evidence (the `sources` cited are general research
// studies, not this specific user) — this registry never tracks or blends
// in personal data itself; that's the experiments/findings stores' job.
//
// AUDITABILITY (harden pass, item 7): every entry's `sources` array carries
// real, independently verifiable metadata (title, journal/publication,
// year, and a PMID/DOI or URL) — never a vague placeholder like "established
// HRV literature". Citations here were verified via literature search
// before being added; nothing is invented. An entry with no citation this
// module's author could resposibly verify is tiered `SUPPORTED_ASSOCIATION`
// (a real, generally-accepted physiological pattern without one attached,
// checkable reference) or `MODEL_HYPOTHESIS` (too variable/unverified to
// assert even that) — never silently upgraded to `ESTABLISHED` with a
// fabricated citation to make it look more authoritative than it is.
//
// This registry migrates context-semantics.js's CAUSE_CONCEPTS (the flat
// {tag, regex} list used only to detect WHETHER text plausibly names a
// physiological cause) into structured relations that also say how strong,
// how long, and what language is justified. context-semantics.js's
// causeConceptTags/CAUSE_CONCEPTS remain the deterministic TEXT-MATCHING
// layer (unchanged) — this registry is the knowledge layer a compiled
// ContextAssertion's `concepts` are checked against to decide whether — and
// how confidently — a relation to a metric is justified.
'use strict';

const KNOWLEDGE_REGISTRY_VERSION = '2.0.0';

// The universal 5-tier evidence vocabulary (truth-and-evidence contract,
// audit priority #1) — every user-facing claim across every NormOS surface
// is tagged with exactly one of these, from strongest generalizable
// evidence for a RELATIONSHIP down to a bare current fact with no inferred
// relationship at all:
//   1. ESTABLISHED         — curated, cited population-level science (THIS
//      registry's own entries: "alcohol suppresses next-morning HRV").
//   2. PERSONAL_EXPERIMENT — a completed, confirmed N-of-1 self-experiment
//      on the exact relationship (store/experiments.js).
//   3. PERSONAL_OBSERVATION — a repeated, statistically-supported personal
//      association (a correlation finding with sample size/confidence —
//      store/findings.js), never described as proof.
//   4. MODEL_HYPOTHESIS    — an emerging signal: preliminary, too limited to
//      call an association yet (a proposed/running experiment, a single
//      low-n observation).
//   5. DIRECT_OBSERVATION  — a raw current fact with NO inferred
//      relationship at all (today's recovery band, whether a goal is
//      checked off, this month's spend total). Distinct from ESTABLISHED:
//      a direct DB read is exactly as solid as curated science for THIS
//      instant, but it is not a citable, generalizable claim about how two
//      things relate — conflating the two is exactly how "generic
//      scientific knowledge" and "a personalized finding" get confused for
//      each other. See brain/evidenceClaim.js's buildEvidenceClaims for the
//      claims that use this tier.
const EVIDENCE_TIER = Object.freeze({
  ESTABLISHED: 'established',                   // well-supported, specifically-cited population relationship
  SUPPORTED_ASSOCIATION: 'supported_association', // a real, generally-accepted physiological pattern, but without one specific verified citation attached to THIS entry
  PERSONAL_EXPERIMENT: 'personal_experiment',    // confirmed N-of-1 self-experiment (tracked in store/experiments.js, not here)
  PERSONAL_OBSERVATION: 'personal_observation',  // an observed personal correlation only (tracked in findings, not here)
  MODEL_HYPOTHESIS: 'model_hypothesis',          // proposed, not backed by either of the above
  DIRECT_OBSERVATION: 'direct_observation',      // a raw current fact, no inferred relationship (see note above)
});

// User-facing labels for each tier — NEVER render the raw enum value in the
// UI (internal implementation vocabulary). Deliberately plain, non-jargon
// phrasing a non-technical user reads naturally in a small caption/badge.
const EVIDENCE_TIER_LABEL = Object.freeze({
  [EVIDENCE_TIER.ESTABLISHED]: 'Established evidence',
  [EVIDENCE_TIER.PERSONAL_EXPERIMENT]: 'Confirmed by your experiment',
  [EVIDENCE_TIER.PERSONAL_OBSERVATION]: 'A pattern in your data',
  [EVIDENCE_TIER.SUPPORTED_ASSOCIATION]: 'A known general pattern',
  [EVIDENCE_TIER.MODEL_HYPOTHESIS]: 'Early signal',
  [EVIDENCE_TIER.DIRECT_OBSERVATION]: 'Direct reading',
});

const POPULATION_EVIDENCE_NOTE =
  'Population-level evidence only — describes a general physiological pattern observed across study subjects, not this specific user. ' +
  'A confirmed personal experiment or observed personal correlation for the SAME relationship is tracked separately (store/experiments.js, ' +
  'findings) and combines with this at resolve time (context-resolver.js\'s driver scoring weights personal_experiment/personal_observation ' +
  'independently) — this registry entry never itself contains or infers personal data.';

// Every entry: sourceConcept, targetConcept, expectedDirection, evidenceTier,
// onsetHours/effectWindowHours/decayHalfLifeHours + effectWindowRationale
// (why THIS many hours, not an arbitrary number), qualifiers, sources
// (structured, verifiable citations — see AUDITABILITY above),
// populationEvidenceNote, allowedLanguage/prohibitedLanguage, version,
// reviewDate. `sourceConcept` matches context-semantics.js's CAUSE_CONCEPTS
// tags 1:1 so a compiled assertion's `concepts` can look itself up here
// directly — one shared vocabulary, not two that could drift.
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
    effectWindowRationale: 'Koskinen et al. (1994) measured acute HRV suppression within hours of intake; the Finnish real-world cohort '
      + '(Kettunen et al., PMC5878366) observed suppressed parasympathetic regulation through the first hours of sleep specifically — a '
      + '24h window covers the overnight autonomic read this registry entry exists to explain, without extending into a second night.',
    qualifiers: ['dose-dependent', 'stronger the closer to bedtime'],
    sources: [
      {
        title: 'Acute alcohol intake decreases short-term heart rate variability in healthy subjects',
        authors: 'Koskinen P, Virolainen J, Kupari M',
        publication: 'Clinical Science', year: 1994, evidenceType: 'controlled_study',
        url: 'https://pubmed.ncbi.nlm.nih.gov/7924168/', pmid: '7924168',
      },
      {
        title: 'Acute Effect of Alcohol Intake on Cardiovascular Autonomic Regulation During the First Hours of Sleep in a Large '
          + 'Real-World Sample of Finnish Employees: Observational Study',
        authors: null, publication: 'JMIR (via PMC)', year: 2018, evidenceType: 'observational_study',
        url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC5878366/', pmid: 'PMC5878366',
      },
    ],
    populationEvidenceNote: POPULATION_EVIDENCE_NOTE,
    allowedLanguage: ['is associated with', 'is a likely contributor to', 'commonly suppresses next-morning'],
    prohibitedLanguage: ['confirmed cause', 'proven to cause', 'guaranteed to'],
    version: '2.0.0',
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
    effectWindowRationale: 'Kim et al.\'s meta-analysis synthesizes acute-stressor HRV studies (mental arithmetic, TSST, speech tasks) '
      + 'showing suppression during and shortly after the stressor; a 24h window covers same-day acute stress carrying into that '
      + 'night\'s autonomic reading without assuming multi-day persistence the meta-analysis does not establish for a single episode.',
    qualifiers: ['acute psychological stress is a well-established HRV suppressor'],
    sources: [
      {
        title: 'Stress and Heart Rate Variability: A Meta-Analysis and Review of the Literature',
        authors: 'Kim HG, Cheon EJ, Bai DS, Lee YH, Koo BH',
        publication: 'Psychiatry Investigation', year: 2018, evidenceType: 'meta_analysis',
        url: 'https://pubmed.ncbi.nlm.nih.gov/29486547/', doi: '10.30773/pi.2017.08.17',
      },
    ],
    populationEvidenceNote: POPULATION_EVIDENCE_NOTE,
    allowedLanguage: ['is associated with', 'is a likely contributor to'],
    prohibitedLanguage: ['confirmed cause', 'proven to cause'],
    version: '2.0.0',
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
    effectWindowRationale: 'The Academy Rugby Union study measured suppressed next-day recovery indices after high training loads, with '
      + 'indices trending back by the following day; 36h covers "next morning" plus a margin without assuming the suppression persists '
      + 'into a second full day, which that single-session study does not test.',
    qualifiers: ['dose-dependent on training load/intensity'],
    sources: [
      {
        title: 'Next Day Subjective and Objective Recovery Indices Following Acute Low and High Training Loads in Academy Rugby Union Players',
        authors: null, publication: 'Sports (MDPI)', year: 2018, evidenceType: 'controlled_study',
        url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6026827/', pmid: '29910360',
      },
    ],
    populationEvidenceNote: POPULATION_EVIDENCE_NOTE,
    allowedLanguage: ['is associated with', 'is a likely contributor to'],
    prohibitedLanguage: ['confirmed cause', 'proven to cause'],
    version: '2.0.0',
    reviewDate: '2026-07-17',
  },
  {
    id: 'illness_recovery_autonomic',
    sourceConcept: 'illness',
    targetConcept: 'health:recovery_autonomic',
    expectedDirection: 'negative',
    // Downgraded from a prior "established" label that carried only a
    // placeholder description, not a specific verified citation (see
    // AUDITABILITY above) — acute illness/immune-activation suppressing HRV
    // is a real, widely-taught physiological pattern (the autonomic
    // "sickness behavior" response), but no single peer-reviewed citation
    // has been verified for THIS registry entry yet.
    evidenceTier: EVIDENCE_TIER.SUPPORTED_ASSOCIATION,
    onsetHours: 0,
    effectWindowHours: 48,
    decayHalfLifeHours: 24,
    effectWindowRationale: 'Conservative estimate pending a verified citation: acute-phase immune activation is generally understood to '
      + 'suppress vagal tone for the duration of acute symptoms plus early recovery; 48h is a cautious upper bound, not derived from a '
      + 'specific measured study for this entry.',
    qualifiers: ['magnitude scales with severity', 'no specific citation verified for this entry — see evidenceTier'],
    sources: [],
    populationEvidenceNote: POPULATION_EVIDENCE_NOTE,
    allowedLanguage: ['may be associated with', 'is a plausible contributor to'],
    prohibitedLanguage: ['is associated with', 'confirmed cause', 'proven to cause', 'likely contributor'],
    version: '2.0.0',
    reviewDate: '2026-07-17',
  },
  {
    id: 'travel_recovery_autonomic',
    sourceConcept: 'travel',
    targetConcept: 'health:recovery_autonomic',
    expectedDirection: 'negative',
    evidenceTier: EVIDENCE_TIER.SUPPORTED_ASSOCIATION, // no citation verified for this entry yet — see illness above for the same reasoning
    onsetHours: 0,
    effectWindowHours: 48,
    decayHalfLifeHours: 24,
    effectWindowRationale: 'Conservative estimate pending a verified citation: circadian disruption from timezone travel is a widely-taught '
      + 'pattern; 48h is a cautious bound pending a specific measured source for this entry.',
    qualifiers: ['stronger across multiple time zones', 'no specific citation verified for this entry — see evidenceTier'],
    sources: [],
    populationEvidenceNote: POPULATION_EVIDENCE_NOTE,
    allowedLanguage: ['may be associated with', 'is a plausible contributor to'],
    prohibitedLanguage: ['is associated with', 'confirmed cause', 'proven to cause', 'likely contributor'],
    version: '2.0.0',
    reviewDate: '2026-07-17',
  },
  {
    id: 'room_conditions_sleep_quality',
    sourceConcept: 'room_conditions',
    targetConcept: 'health:sleep_quality',
    expectedDirection: 'negative',
    evidenceTier: EVIDENCE_TIER.SUPPORTED_ASSOCIATION, // no citation verified for this entry yet
    onsetHours: 0,
    effectWindowHours: 12,
    decayHalfLifeHours: 6,
    effectWindowRationale: 'Bounded to a single night (12h) — thermal/noise disruption is a same-night sleep-quality factor with no '
      + 'basis in the available sources for assuming next-night carryover.',
    qualifiers: ['thermal discomfort and noise are both widely-taught sleep-quality disruptors', 'no specific citation verified for this entry'],
    sources: [],
    populationEvidenceNote: POPULATION_EVIDENCE_NOTE,
    allowedLanguage: ['may be associated with', 'is a plausible contributor to'],
    prohibitedLanguage: ['is associated with', 'confirmed cause', 'proven to cause', 'likely contributor'],
    version: '2.0.0',
    reviewDate: '2026-07-17',
  },
  {
    id: 'late_meal_recovery_autonomic',
    sourceConcept: 'late_meal',
    targetConcept: 'health:recovery_autonomic',
    expectedDirection: 'negative',
    evidenceTier: EVIDENCE_TIER.SUPPORTED_ASSOCIATION, // no citation verified for this entry yet
    onsetHours: 0,
    effectWindowHours: 12,
    decayHalfLifeHours: 6,
    effectWindowRationale: 'Bounded to the same night (12h) — digestive/postprandial autonomic load from a late or heavy meal is a '
      + 'same-night factor; no source verified for this entry supports a longer window.',
    qualifiers: ['effect is modest relative to alcohol/illness', 'no specific citation verified for this entry'],
    sources: [],
    populationEvidenceNote: POPULATION_EVIDENCE_NOTE,
    allowedLanguage: ['may be a modest factor in', 'is a plausible contributor to'],
    prohibitedLanguage: ['is associated with', 'confirmed cause', 'proven to cause', 'major cause', 'likely contributor'],
    version: '2.0.0',
    reviewDate: '2026-07-17',
  },
  {
    id: 'medication_recovery_autonomic',
    sourceConcept: 'medication',
    targetConcept: 'health:recovery_autonomic',
    expectedDirection: 'unknown',
    // Deliberately the lowest tier — effect direction and magnitude vary
    // enormously by drug class (some suppress HRV, some have no autonomic
    // effect, a few improve it). A general "medication affects recovery"
    // relation would be too broad to be trustworthy at ANY higher tier
    // until/unless a specific drug-level entry replaces this one.
    evidenceTier: EVIDENCE_TIER.MODEL_HYPOTHESIS,
    onsetHours: null,
    effectWindowHours: 24,
    decayHalfLifeHours: null,
    effectWindowRationale: 'No fixed window is defensible at this tier — 24h is an arbitrary cap so a relation can never be permanently '
      + 'active, not a claim about pharmacological duration.',
    qualifiers: ['effect direction and magnitude depend entirely on the specific medication'],
    sources: [],
    populationEvidenceNote: POPULATION_EVIDENCE_NOTE,
    allowedLanguage: ['may be worth watching', 'is a possible factor'],
    prohibitedLanguage: ['is associated with', 'confirmed cause', 'proven to cause', 'likely contributor'],
    version: '2.0.0',
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

/** Every distinct sourceConcept the registry knows about — mainly useful
 *  for tests/introspection. */
function allSourceConcepts() {
  return [...new Set(KNOWLEDGE_RELATIONS.map((r) => r.sourceConcept))];
}

module.exports = {
  KNOWLEDGE_REGISTRY_VERSION,
  EVIDENCE_TIER,
  EVIDENCE_TIER_LABEL,
  KNOWLEDGE_RELATIONS,
  knowledgeRelationsForConcept,
  findKnowledgeRelation,
  allSourceConcepts,
};
