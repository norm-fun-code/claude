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
  'qualifiers', 'authoritativeSources', 'allowedLanguage', 'prohibitedLanguage', 'version', 'reviewDate',
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

test('alcohol/illness/travel/stress/hard_training are established-tier (well-supported general relationships)', () => {
  for (const tag of ['alcohol', 'illness', 'travel', 'stress', 'hard_training']) {
    const entries = knowledgeRelationsForConcept(tag);
    assert.ok(entries.length >= 1, `expected at least one entry for "${tag}"`);
    assert.ok(entries.every((e) => e.evidenceTier === EVIDENCE_TIER.ESTABLISHED), `"${tag}" should be established-tier`);
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
