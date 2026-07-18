// Unit coverage for brain/claimValidator.js's checkResolvedContextConflicts —
// the general check that rejects generated text conflicting with
// ResolvedContext (see intelligence/context-resolver.js): negated/retracted
// events cited as fact, a completion state the user explicitly corrected, a
// causal recovery claim naming a driver other than the resolver's top
// candidate (or asserting one when the resolver says unknown), and a
// calendar block described as meeting load after the user reclassified it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateChiefBriefClaims, checkResolvedContextConflicts, briefFields } = require('../src/brain/claimValidator');
const { buildResolvedContext } = require('../src/intelligence/context-resolver');

const NOW = new Date('2026-07-17T15:00:00Z');
const brief = (fields) => ({ chiefBrief: fields });

function resolvedFrom({ assertions = [], relations = [] }) {
  return buildResolvedContext({ assertions, relations, tz: 'America/New_York', now: NOW });
}

test('absent resolvedContext is a no-op (backward compatible)', () => {
  const { violations } = validateChiefBriefClaims(brief({ synthesis: 'You had drinks last night.' }), { recoveryScore: 50 });
  assert.deepEqual(violations.filter((v) => v.check === 'negated_event_cited'), []);
});

test('a negated event cited as if it happened is flagged', () => {
  const resolved = resolvedFrom({
    assertions: [{ id: 'a1', predicate: 'drank', objectValue: 'alcohol', rawText: "I didn't drink last night", eventStatus: 'negated', domains: ['health'] }],
  });
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped, likely because you drank alcohol last night.' }),
    { resolvedContext: resolved }
  );
  assert.ok(violations.some((v) => v.check === 'negated_event_cited'));
});

test('a retracted event cited as if it happened is flagged', () => {
  const resolved = resolvedFrom({
    assertions: [{ id: 'a1', predicate: 'ate', objectValue: 'a late meal', rawText: 'forget what I said about the late meal', eventStatus: 'retracted', domains: ['health'] }],
  });
  const { violations } = validateChiefBriefClaims(
    brief({ risk: 'The late meal you ate is worth watching.' }),
    { resolvedContext: resolved }
  );
  assert.ok(violations.some((v) => v.check === 'negated_event_cited'));
});

test('a genuinely occurred assertion is never flagged as negated', () => {
  const resolved = resolvedFrom({
    assertions: [{ id: 'a1', predicate: 'drank', objectValue: 'wine', rawText: 'drank wine last night', eventStatus: 'occurred', domains: ['health'] }],
  });
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped, likely from drinking wine last night.' }),
    { resolvedContext: resolved }
  );
  assert.equal(violations.filter((v) => v.check === 'negated_event_cited').length, 0);
});

test('a completion state the user explicitly corrected ("did not complete") is flagged even when described as done', () => {
  const resolved = resolvedFrom({
    assertions: [{ id: 'a1', rawText: 'did not complete the valuation conversation', eventStatus: 'negated', domains: ['goals'] }],
    relations: [{
      id: 'r1', sourceAssertionId: 'a1', targetType: 'goal', targetId: 'the_valuation_conversation',
      relationship: 'completes', permittedLanguage: 'not completed', evidenceBasis: 'user_explicit',
      unresolved: false, resolvedAt: null, retiredAt: null, createdAt: NOW.toISOString(),
    }],
  });
  const facts = { resolvedContext: resolved, goals: [{ text: 'The Valuation Conversation', achieved: false }] };
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'The Valuation Conversation is done — nice work.' }), facts
  );
  assert.ok(violations.some((v) => v.check === 'completion_state_resolved'));
});

test('a causal recovery claim naming a driver other than the resolver\'s top candidate is flagged', () => {
  const resolved = resolvedFrom({
    assertions: [{ id: 'a1', predicate: 'drank', objectValue: 'wine', rawText: 'drank wine last night', eventStatus: 'occurred', domains: ['health'] }],
    relations: [{
      id: 'r1', sourceAssertionId: 'a1', targetType: 'metric', targetId: 'health:recovery_autonomic',
      relationship: 'contributes_to', evidenceBasis: 'established_knowledge', confidence: 0.75, strength: 0.7,
      windowStart: NOW.toISOString(), windowEnd: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString(), permittedLanguage: 'is a likely contributor to',
      unresolved: false, resolvedAt: null, retiredAt: null, createdAt: NOW.toISOString(),
    }],
  });
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped because of the stressful deadline at work.' }),
    { resolvedContext: resolved }
  );
  assert.ok(violations.some((v) => v.check === 'resolved_driver_conflict'));
});

test('a causal recovery claim matching the resolver\'s top driver is NOT flagged', () => {
  const resolved = resolvedFrom({
    assertions: [{ id: 'a1', predicate: 'drank', objectValue: 'wine', rawText: 'drank wine last night', eventStatus: 'occurred', domains: ['health'] }],
    relations: [{
      id: 'r1', sourceAssertionId: 'a1', targetType: 'metric', targetId: 'health:recovery_autonomic',
      relationship: 'contributes_to', evidenceBasis: 'established_knowledge', confidence: 0.75, strength: 0.7,
      windowStart: NOW.toISOString(), windowEnd: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString(), permittedLanguage: 'is a likely contributor to',
      unresolved: false, resolvedAt: null, retiredAt: null, createdAt: NOW.toISOString(),
    }],
  });
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped because of the wine last night.' }),
    { resolvedContext: resolved }
  );
  assert.equal(violations.filter((v) => v.check === 'resolved_driver_conflict').length, 0);
});

test('a causal recovery claim when the resolver has NO eligible driver is flagged (should say unknown)', () => {
  const resolved = resolvedFrom({ assertions: [], relations: [] });
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Recovery dipped because of the hard training session yesterday.' }),
    { resolvedContext: resolved }
  );
  assert.ok(violations.some((v) => v.check === 'resolved_driver_conflict' && v.expected.includes('unknown')));
});

test('calendar reclassification: a block described as meeting load after being reclassified is flagged', () => {
  const resolved = resolvedFrom({
    assertions: [{
      id: 'a1', assertionType: 'classification', subject: 'the 5-9pm block', predicate: 'is',
      objectValue: 'a Sabbath observance, not meetings', rawText: "that's a Sabbath block, not meetings",
      eventStatus: 'occurred', domains: ['calendar'],
    }],
    relations: [{
      id: 'r1', sourceAssertionId: 'a1', targetType: 'calendar_event', targetId: 'the_5_9pm_block',
      relationship: 'classifies', evidenceBasis: 'user_explicit', confidence: 0.9,
      permittedLanguage: 'a Sabbath observance, not meetings',
      unresolved: false, resolvedAt: null, retiredAt: null, createdAt: NOW.toISOString(),
    }],
  });
  const { violations } = validateChiefBriefClaims(
    brief({ synthesis: 'Your 5-9pm block is packed with meetings today.' }),
    { resolvedContext: resolved }
  );
  assert.ok(violations.some((v) => v.check === 'calendar_classification'));
});

test('checkResolvedContextConflicts is silent on a clean, fully-consistent brief', () => {
  const resolved = resolvedFrom({
    assertions: [{ id: 'a1', predicate: 'drank', objectValue: 'wine', rawText: 'drank wine last night', eventStatus: 'occurred', domains: ['health'] }],
    relations: [{
      id: 'r1', sourceAssertionId: 'a1', targetType: 'metric', targetId: 'health:recovery_autonomic',
      relationship: 'contributes_to', evidenceBasis: 'established_knowledge', confidence: 0.75, strength: 0.7,
      windowStart: NOW.toISOString(), windowEnd: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString(), permittedLanguage: 'is a likely contributor to',
      unresolved: false, resolvedAt: null, retiredAt: null, createdAt: NOW.toISOString(),
    }],
  });
  const violations = checkResolvedContextConflicts(
    briefFields(brief({ synthesis: 'Recovery dipped because of the wine last night — worth keeping an eye on tonight.' })),
    { resolvedContext: resolved }
  );
  assert.deepEqual(violations, []);
});
