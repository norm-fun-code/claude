// Memory projection (product audit rec #6) — pure-function unit tests for
// intelligence/memory-projection.js's categorization/labeling/status logic.
// No DB — these are the exported pure helpers, mirroring the style of
// test/wealth-landing.test.js and context-resolver's own unit coverage.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  categorizeAssertion, beliefDisplayStatus, assertionStatus, assertionToMemoryItem,
  beliefToMemoryItem, buildMemoryProjection, CATEGORY,
} = require('../src/intelligence/memory-projection');

const TZ = 'America/New_York';

function assertion(overrides = {}) {
  return {
    id: 'a1', sourceAnnotationId: null, source: 'ask', rawText: 'raw text',
    assertionType: 'state', subject: 'x', predicate: 'is', objectValue: 'y',
    entities: [], concepts: [], domains: [], eventStatus: 'occurred',
    effectiveStart: null, effectiveEnd: null, recordedAt: '2026-07-20T12:00:00Z',
    confidence: 0.8, sourceAuthority: 'user', supersedesAssertionId: null,
    compilerVersion: '1.0.0', retiredAt: null, retiredReason: null,
    createdAt: '2026-07-20T12:00:00Z',
    ...overrides,
  };
}

function belief(overrides = {}) {
  return {
    id: 1, kind: 'user_statement', dedup_key: 'stated:x', statement: 'Nancy\'s due date is January 2, 2027',
    confidence: 0.85, evidence: {}, status: 'active', created_at: '2026-07-20T12:00:00Z',
    updated_at: '2026-07-20T12:00:00Z', confirmed_at: null, user_locked: false,
    ...overrides,
  };
}

// ── required: History and Memory return different data contracts (categorization) ──
test('a preference assertion categorizes as stable facts & preferences', () => {
  assert.equal(categorizeAssertion(assertion({ assertionType: 'preference' })), CATEGORY.FACTS_PREFERENCES);
});

test('a classification assertion (a recurring calendar correction) categorizes as routines', () => {
  assert.equal(categorizeAssertion(assertion({ assertionType: 'classification', domains: ['calendar'] })), CATEGORY.ROUTINES);
});

test('a correction assertionType, OR any negated/retracted/superseded eventStatus, always categorizes as corrections/exclusions regardless of assertionType', () => {
  assert.equal(categorizeAssertion(assertion({ assertionType: 'correction' })), CATEGORY.CORRECTIONS);
  assert.equal(categorizeAssertion(assertion({ assertionType: 'preference', eventStatus: 'retracted' })), CATEGORY.CORRECTIONS);
  assert.equal(categorizeAssertion(assertion({ assertionType: 'state', eventStatus: 'negated' })), CATEGORY.CORRECTIONS);
});

test('a decision assertionType, or a commitments-domain assertion, categorizes as decisions & commitments', () => {
  assert.equal(categorizeAssertion(assertion({ assertionType: 'decision' })), CATEGORY.DECISIONS);
  assert.equal(categorizeAssertion(assertion({ assertionType: 'state', domains: ['commitments'] })), CATEGORY.DECISIONS);
});

test('a goals-domain assertion categorizes as goals & active projects', () => {
  assert.equal(categorizeAssertion(assertion({ assertionType: 'plan', domains: ['goals'] })), CATEGORY.GOALS);
});

test('an event assertionType categorizes as time-bounded events', () => {
  assert.equal(categorizeAssertion(assertion({ assertionType: 'event' })), CATEGORY.EVENTS);
});

test('a person-flavored subject with no other domain claiming it categorizes as people & relationships', () => {
  assert.equal(categorizeAssertion(assertion({ assertionType: 'state', subject: "Nancy's due date", domains: [] })), CATEGORY.PEOPLE);
});

test('a lowercase/non-person subject falls back to stable facts, never mis-tagged as people', () => {
  assert.equal(categorizeAssertion(assertion({ assertionType: 'state', subject: 'the thermostat', domains: [] })), CATEGORY.FACTS_PREFERENCES);
});

// ── required: superseded facts remain auditable but are not reasoning-eligible ──
test('a retired assertion that another assertion supersedes is status=superseded, not eligible for reasoning', () => {
  const old = assertion({ id: 'old1', retiredAt: '2026-07-21T00:00:00Z', retiredReason: 'superseded by a new assertion' });
  const supersededByIds = new Set(['old1']);
  const item = assertionToMemoryItem(old, { asOf: new Date('2026-07-22'), tz: TZ, supersededByIds });
  assert.equal(item.status, 'superseded');
  assert.equal(item.eligibleForReasoning, false);
});

test('a retired assertion nothing points at (a plain forget/retraction) is status=retracted', () => {
  const old = assertion({ id: 'old2', retiredAt: '2026-07-21T00:00:00Z' });
  const item = assertionToMemoryItem(old, { asOf: new Date('2026-07-22'), tz: TZ, supersededByIds: new Set() });
  assert.equal(item.status, 'retracted');
  assert.equal(item.eligibleForReasoning, false);
});

// ── required: a time-bounded fast expires and cannot influence later current-day reasoning ──
test('an episodic event past its effectiveEnd is status=expired, not eligible for reasoning, and carries an "Ended <date> · expired event" temporal label', () => {
  const fast = assertion({
    id: 'fast1', assertionType: 'event', eventStatus: 'completed',
    effectiveStart: '2026-07-17T00:00:00Z', effectiveEnd: '2026-07-18T05:00:00Z',
  });
  const item = assertionToMemoryItem(fast, { asOf: new Date('2026-07-28T12:00:00Z'), tz: TZ, supersededByIds: new Set() });
  assert.equal(item.status, 'expired');
  assert.equal(item.eligibleForReasoning, false);
  assert.match(item.temporalLabel, /^Ended .* · expired event$/);
});

test('the SAME fast, read on the day it applies, is still active/eligible', () => {
  const fast = assertion({
    id: 'fast2', assertionType: 'event', eventStatus: 'ongoing',
    effectiveStart: '2026-07-17T00:00:00Z', effectiveEnd: '2026-07-18T05:00:00Z',
  });
  const item = assertionToMemoryItem(fast, { asOf: new Date('2026-07-17T20:00:00Z'), tz: TZ, supersededByIds: new Set() });
  assert.equal(item.status, 'active');
  assert.equal(item.eligibleForReasoning, true);
});

// ── required: no raw internal metadata leaks (statement/reason are human strings, never enums) ──
test('assertionToMemoryItem never surfaces the raw sourceAuthority/assertionType/eventStatus enums as the displayed reason — only a human sentence', () => {
  const a = assertion({ sourceAuthority: 'established_knowledge' });
  const item = assertionToMemoryItem(a, { asOf: new Date(), tz: TZ, supersededByIds: new Set() });
  assert.equal(item.reason, 'Established knowledge');
  assert.notEqual(item.reason, 'established_knowledge');
});

test('a durable preference never expires and is labeled as a standing preference', () => {
  const pref = assertion({ assertionType: 'preference', effectiveEnd: null });
  const item = assertionToMemoryItem(pref, { asOf: new Date('2030-01-01'), tz: TZ, supersededByIds: new Set() });
  assert.equal(item.status, 'active');
  assert.equal(item.temporalLabel, 'Standing preference · no expiration');
  assert.equal(item.actions.canMarkTemporary, true, 'a durable preference should be offered "mark temporary"');
});

// ── beliefs mirror the Health tab's existing status vocabulary exactly ──
test('beliefDisplayStatus matches routes/beliefs.js exactly: retired > confirmed > supported/hypothesis by confidence', () => {
  assert.equal(beliefDisplayStatus(belief({ status: 'retired' })), 'retired');
  assert.equal(beliefDisplayStatus(belief({ confirmed_at: '2026-07-01T00:00:00Z' })), 'confirmed');
  assert.equal(beliefDisplayStatus(belief({ confidence: 0.9 })), 'supported');
  assert.equal(beliefDisplayStatus(belief({ confidence: 0.2 })), 'hypothesis');
});

test('a belief-origin memory item is only offered Confirm when active and not already confirmed', () => {
  const active = beliefToMemoryItem(belief({}));
  assert.equal(active.actions.canConfirm, true);
  const confirmed = beliefToMemoryItem(belief({ confirmed_at: '2026-07-01T00:00:00Z' }));
  assert.equal(confirmed.actions.canConfirm, false, 'confirming an already-confirmed belief materially changes nothing');
  const retired = beliefToMemoryItem(belief({ status: 'retired' }));
  assert.equal(retired.actions.canConfirm, false);
});

// ── required: History and Memory return different data contracts / a saved chat is not a durable memory ──
test('buildMemoryProjection never includes anything chat/conversation-shaped — every item has origin assertion|belief, never a chat message/conversation id', () => {
  const projection = buildMemoryProjection({
    assertions: [assertion({ id: 'x1' })],
    retiredAssertions: [],
    beliefs: [belief({})],
    asOf: new Date('2026-07-28'),
    tz: TZ,
  });
  const all = [...projection.active, ...projection.historical];
  assert.ok(all.length > 0);
  for (const item of all) {
    assert.ok(['assertion', 'belief'].includes(item.origin));
    assert.ok(!('conversationId' in item));
    assert.ok(!('savedAt' in item));
    assert.ok(!('messageCount' in item));
  }
});

test('buildMemoryProjection splits active vs historical correctly and sorts each by recency', () => {
  const active1 = assertion({ id: 'act1', recordedAt: '2026-07-10T00:00:00Z' });
  const active2 = assertion({ id: 'act2', recordedAt: '2026-07-20T00:00:00Z' });
  const retired1 = assertion({ id: 'ret1', retiredAt: '2026-07-15T00:00:00Z', recordedAt: '2026-07-05T00:00:00Z' });
  const projection = buildMemoryProjection({
    assertions: [active1, active2], retiredAssertions: [retired1], beliefs: [],
    asOf: new Date('2026-07-28'), tz: TZ,
  });
  assert.equal(projection.active.length, 2);
  assert.equal(projection.active[0].rawId, 'act2', 'most recent active item first');
  assert.equal(projection.historical.length, 1);
  assert.equal(projection.historical[0].rawId, 'ret1');
});
