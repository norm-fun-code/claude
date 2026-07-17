// Pure structural coverage for intelligence/knowledge-registry.js — the
// versioned KnowledgeRelation registry that migrates context-semantics.js's
// CAUSE_CONCEPTS tags into structured, evidence-tiered relations.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  KNOWLEDGE_RELATIONS, EVIDENCE_TIER, knowledgeRelationsForConcept, findKnowledgeRelation, allSourceConcepts,
} = require('../src/intelligence/knowledge-registry');
const { causeConceptTags } = require('../src/intelligence/context-semantics');

const REQUIRED_FIELDS = [
  'id', 'sourceConcept', 'targetConcept', 'expectedDirection', 'evidenceTier',
  'effectWindowRationale', 'qualifiers', 'sources', 'populationEvidenceNote',
  'allowedLanguage', 'prohibitedLanguage', 'version', 'reviewDate',
];

test('every entry has all required KnowledgeRelation fields', () => {
  for (const entry of KNOWLEDGE_RELATIONS) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in entry, `entry ${entry.id} is missing field "${field}"`);
    }
    assert.ok(Object.values(EVIDENCE_TIER).includes(entry.evidenceTier), `entry ${entry.id} has an unrecognized evidenceTier`);
  }
});

test('every entry id is unique', () => {
  const ids = KNOWLEDGE_RELATIONS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every context-semantics.js CAUSE_CONCEPTS tag has been migrated into the registry', () => {
  // causeConceptTags has no direct export of the tag list, so derive it from
  // known trigger phrases for each of the 8 documented tags.
  const probes = {
    alcohol: 'drank wine', illness: 'had a fever', travel: 'jet lagged from the flight',
    room_conditions: 'the room was hot', late_meal: 'ate a heavy dinner late',
    medication: 'started a new medication', stress: 'a stressful deadline', hard_training: 'an intense training session',
  };
  for (const [tag, probe] of Object.entries(probes)) {
    assert.ok(causeConceptTags(probe).includes(tag), `sanity: probe for "${tag}" should still match context-semantics.js`);
    assert.ok(allSourceConcepts().includes(tag), `CAUSE_CONCEPTS tag "${tag}" has no corresponding knowledge-registry entry`);
  }
});

test('medication stays a visibly-uncertain model_hypothesis (evidence genuinely varies per-drug)', () => {
  const entries = knowledgeRelationsForConcept('medication');
  assert.ok(entries.length >= 1);
  for (const e of entries) assert.equal(e.evidenceTier, EVIDENCE_TIER.MODEL_HYPOTHESIS);
});

// ── Auditability (harden pass, item 7) ────────────────────────────────────
// Only alcohol/stress/hard_training carry a specific, independently
// verified citation (title/publication/year/PMID-or-DOI found via literature
// search before this entry was written) — every other concept was
// DOWNGRADED to supported_association rather than left at (or promoted to)
// "established" with an invented or unverifiable source. This is the
// concrete, checkable claim item 7 requires: never fabricate a citation.
const ESTABLISHED_WITH_VERIFIED_CITATION = ['alcohol', 'stress', 'hard_training'];
const DOWNGRADED_NO_VERIFIED_CITATION = ['illness', 'travel', 'room_conditions', 'late_meal'];

test('established-tier entries are exactly the ones with a verified citation attached', () => {
  for (const tag of ESTABLISHED_WITH_VERIFIED_CITATION) {
    const entries = knowledgeRelationsForConcept(tag);
    assert.ok(entries.length >= 1, `expected at least one entry for "${tag}"`);
    for (const e of entries) {
      assert.equal(e.evidenceTier, EVIDENCE_TIER.ESTABLISHED, `"${tag}" should be established-tier`);
      assert.ok(e.sources.length >= 1, `established entry "${e.id}" must carry at least one source`);
    }
  }
  // No OTHER concept is established-tier — established is reserved for
  // entries with a verified citation, never granted by default.
  for (const entry of KNOWLEDGE_RELATIONS) {
    if (entry.evidenceTier === EVIDENCE_TIER.ESTABLISHED) {
      assert.ok(
        ESTABLISHED_WITH_VERIFIED_CITATION.includes(entry.sourceConcept),
        `"${entry.sourceConcept}" is established-tier but is not in the verified-citation allowlist — every established entry must carry a real citation`
      );
    }
  }
});

test('every established entry\'s source has real, checkable metadata (title, publication, year, and a PMID/DOI/URL) — never a vague placeholder', () => {
  for (const entry of KNOWLEDGE_RELATIONS.filter((e) => e.evidenceTier === EVIDENCE_TIER.ESTABLISHED)) {
    for (const src of entry.sources) {
      assert.ok(src.title && src.title.trim().length > 10, `${entry.id}: source title must be a real, specific paper title, not a placeholder`);
      assert.ok(src.publication, `${entry.id}: source must name a publication/journal`);
      assert.ok(Number.isInteger(src.year) && src.year > 1900 && src.year <= 2026, `${entry.id}: source must have a plausible real year`);
      assert.ok(src.url || src.doi || src.pmid, `${entry.id}: source must carry a URL, DOI, or PMID so it can actually be looked up`);
      assert.ok(src.evidenceType, `${entry.id}: source must state its evidence type (e.g. controlled_study, meta_analysis, observational_study)`);
      // Guard against the exact class of placeholder this harden pass
      // removed ("established HRV literature" with no real citation).
      assert.doesNotMatch(src.title.toLowerCase(), /^established .* literature$/, `${entry.id}: source title reads like a placeholder, not a real paper title`);
    }
  }
});

test('entries downgraded for lack of a verified citation are supported_association, not established, and have an empty sources array (honestly, not padded)', () => {
  for (const tag of DOWNGRADED_NO_VERIFIED_CITATION) {
    const entries = knowledgeRelationsForConcept(tag);
    assert.ok(entries.length >= 1, `expected at least one entry for "${tag}"`);
    for (const e of entries) {
      assert.equal(e.evidenceTier, EVIDENCE_TIER.SUPPORTED_ASSOCIATION, `"${tag}" should be supported_association (no verified citation)`);
      assert.deepEqual(e.sources, [], `${e.id}: no verified source exists for this entry — sources must stay empty, not invented`);
    }
  }
});

test('every entry documents WHY its effect window is what it is (effectWindowRationale), not just a bare number', () => {
  for (const entry of KNOWLEDGE_RELATIONS) {
    assert.ok(entry.effectWindowRationale && entry.effectWindowRationale.trim().length > 20, `${entry.id}: effectWindowRationale must be a real explanation, not empty/trivial`);
  }
});

test('every entry explicitly distinguishes population evidence from personal evidence', () => {
  for (const entry of KNOWLEDGE_RELATIONS) {
    assert.match(entry.populationEvidenceNote, /population/i);
    assert.match(entry.populationEvidenceNote, /personal/i);
  }
});

test('findKnowledgeRelation returns the exact (sourceConcept, targetConcept) match', () => {
  const entry = findKnowledgeRelation('alcohol', 'health:recovery_autonomic');
  assert.ok(entry);
  assert.equal(entry.sourceConcept, 'alcohol');
});

test('findKnowledgeRelation returns null for an unmatched pair', () => {
  assert.equal(findKnowledgeRelation('alcohol', 'wealth:spending'), null);
  assert.equal(findKnowledgeRelation('nonexistent_concept', 'health:recovery_autonomic'), null);
});

test('every allowedLanguage/prohibitedLanguage entry is non-empty text, never overlapping between allowed and prohibited', () => {
  for (const entry of KNOWLEDGE_RELATIONS) {
    for (const phrase of entry.allowedLanguage) assert.ok(phrase && phrase.trim().length > 0);
    for (const phrase of entry.prohibitedLanguage) assert.ok(phrase && phrase.trim().length > 0);
    const allowedSet = new Set(entry.allowedLanguage);
    for (const p of entry.prohibitedLanguage) {
      assert.ok(!allowedSet.has(p), `"${p}" appears in both allowed and prohibited language for ${entry.id}`);
    }
  }
});
