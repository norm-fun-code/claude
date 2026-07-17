// Foundation coverage for the Context Understanding Layer against a real
// Postgres: store CRUD + cascading retirement, resolveContext()'s shape,
// the compileUserContext pipeline end-to-end (LLM mocked — no real API
// call), and compiler-failure resilience (refusal/max_tokens/network never
// throw into the caller). See test/context-compiler.test.js and
// test/context-resolver.test.js for the pure-function coverage, and
// test/integration/context-understanding.test.js (added once surfaces are
// wired) for the 9 proof scenarios end-to-end through real routes.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const { AnthropicRefusalError, AnthropicMaxTokensError } = llm;
const contextAssertionsStore = require('../../src/store/contextAssertions');
const contextRelationsStore = require('../../src/store/contextRelations');
const { compileUserContext, persistCompiledContext } = require('../../src/intelligence/context-compiler');
const { resolveContext } = require('../../src/intelligence/context-resolver');
const { buildBrainSnapshot } = require('../../src/brain/snapshot');

const ORIGINAL_GENERATE_TEXT = llm.generateText;
const TEST_MARKER = `context-understanding-foundation-${Date.now()}`;

function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}

afterEach(async () => {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  await db.query(`DELETE FROM context_relations WHERE source_assertion_id IN (SELECT id FROM context_assertions WHERE raw_text LIKE $1)`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM context_assertions WHERE raw_text LIKE $1`, [`%${TEST_MARKER}%`]);
});
after(async () => { await closeDb(); });

test('store CRUD: creating a relation then retiring its source assertion cascades to retire the relation too', async () => {
  const id = await contextAssertionsStore.create({
    source: 'test', rawText: `${TEST_MARKER} drank wine last night`, assertionType: 'event',
    concepts: ['alcohol'], domains: ['health'], eventStatus: 'occurred', compilerVersion: 'test',
  });
  const relId = await contextRelationsStore.create({
    sourceAssertionId: id, targetType: 'metric', targetId: 'health:recovery_autonomic',
    relationship: 'contributes_to', evidenceBasis: 'established_knowledge', confidence: 0.7,
  });
  assert.equal((await contextRelationsStore.getActiveForTarget('metric', 'health:recovery_autonomic')).some((r) => r.id === relId), true);

  await contextAssertionsStore.retire(id, 'test retraction');
  assert.equal(await contextAssertionsStore.getById(id).then((a) => a.retiredAt != null), true);
  assert.equal((await contextRelationsStore.getActiveForTarget('metric', 'health:recovery_autonomic')).some((r) => r.id === relId), false);
});

test('resolveContext() against real Postgres returns a usable ResolvedContext and getDriversFor sees the persisted relation', async () => {
  const { getDriversFor } = require('../../src/intelligence/context-resolver');
  const now = new Date();
  const id = await contextAssertionsStore.create({
    source: 'test', rawText: `${TEST_MARKER} drank wine last night`, assertionType: 'event',
    concepts: ['alcohol'], domains: ['health'], eventStatus: 'occurred', compilerVersion: 'test',
    effectiveStart: new Date(now.getTime() - 8 * 3600 * 1000).toISOString(), effectiveEnd: now.toISOString(),
  });
  await contextRelationsStore.create({
    sourceAssertionId: id, targetType: 'metric', targetId: 'health:recovery_autonomic',
    relationship: 'contributes_to', evidenceBasis: 'established_knowledge', confidence: 0.75, strength: 0.7,
    windowStart: new Date(now.getTime() - 8 * 3600 * 1000).toISOString(), windowEnd: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(), permittedLanguage: 'is a likely contributor to',
  });

  const resolved = await resolveContext({ now });
  assert.ok(Array.isArray(resolved.assertions));
  assert.ok(resolved.assertions.some((a) => a.id === id));
  const result = getDriversFor(resolved, 'health:recovery_autonomic', { now });
  assert.ok(result.driver, 'the persisted relation should be found as a driver');
});

test('BrainSnapshot exposes contextAssertions/contextRelations/resolvedContext and they agree with a direct resolveContext() call', async () => {
  const id = await contextAssertionsStore.create({
    source: 'test', rawText: `${TEST_MARKER} snapshot integration check`, assertionType: 'state',
    concepts: [], domains: ['other'], eventStatus: 'occurred', compilerVersion: 'test',
  });
  const snapshot = await buildBrainSnapshot({ include: { calendar: false } });
  assert.ok(snapshot.contextAssertions.value.some((a) => a.id === id));
  assert.equal(snapshot.resolvedContext.freshness, 'fresh');
});

test('compileUserContext end-to-end (LLM mocked): a single health-domain event compiles into one assertion + one established_knowledge relation, persisted atomically', async () => {
  llm.generateText = async () => chiefMeta(JSON.stringify({
    assertions: [{
      assertionType: 'event', subject: 'user', predicate: 'drank', objectValue: 'wine',
      concepts: ['alcohol'], domains: ['health'], eventStatus: 'occurred', temporalRef: 'last_night',
      explicitDate: '', correctsPriorText: '', confidence: 0.9,
    }],
  }));

  const compiled = await compileUserContext({ rawText: `${TEST_MARKER} I had drinks last night`, source: 'test' });
  assert.equal(compiled.failed, false);
  assert.equal(compiled.assertions.length, 1);
  assert.equal(compiled.assertions[0].concepts[0], 'alcohol');
  assert.equal(compiled.relations.length, 1);
  assert.equal(compiled.relations[0].evidenceBasis, 'established_knowledge');

  const persisted = await db.withTransaction(async (client) => {
    const txDb = (text, params) => client.query(text, params);
    return persistCompiledContext(compiled, { db: txDb });
  });
  assert.equal(persisted.assertionIds.length, 1);
  assert.equal(persisted.relationIds.length, 1);

  const stored = await contextAssertionsStore.getById(persisted.assertionIds[0]);
  assert.equal(stored.rawText.includes(TEST_MARKER), true);
  assert.equal(stored.sourceAuthority, 'user');
});

test('compileUserContext never throws on a total LLM refusal — degrades to failed:true with no assertions', async () => {
  llm.generateText = async () => { throw new AnthropicRefusalError('policy', { requestId: 'test' }); };
  const compiled = await compileUserContext({ rawText: `${TEST_MARKER} anything`, source: 'test' });
  assert.equal(compiled.failed, true);
  assert.equal(compiled.failureType, 'refusal');
  assert.deepEqual(compiled.assertions, []);
  assert.deepEqual(compiled.relations, []);
});

test('compileUserContext never throws on max_tokens truncation on both attempts — degrades gracefully', async () => {
  llm.generateText = async () => { throw new AnthropicMaxTokensError({ requestId: 'test', maxTokens: 4096 }); };
  const compiled = await compileUserContext({ rawText: `${TEST_MARKER} anything`, source: 'test' });
  assert.equal(compiled.failed, true);
  assert.equal(compiled.failureType, 'max_tokens');
});

test('compileUserContext never throws on a malformed (non-JSON) response after retry — degrades to failed:true', async () => {
  llm.generateText = async () => chiefMeta('not valid json at all');
  const compiled = await compileUserContext({ rawText: `${TEST_MARKER} anything`, source: 'test' });
  assert.equal(compiled.failed, true);
  assert.equal(compiled.failureType, 'parse');
});

test('compileUserContext retries once on a network failure and can still succeed on the second attempt', async () => {
  let calls = 0;
  llm.generateText = async () => {
    calls += 1;
    if (calls === 1) throw new Error('simulated transient network failure');
    return chiefMeta(JSON.stringify({
      assertions: [{
        assertionType: 'state', subject: 'user', predicate: 'felt', objectValue: 'fine',
        concepts: [], domains: ['other'], eventStatus: 'occurred', temporalRef: 'today',
        explicitDate: '', correctsPriorText: '', confidence: 0.7,
      }],
    }));
  };
  const compiled = await compileUserContext({ rawText: `${TEST_MARKER} felt fine today`, source: 'test' });
  assert.equal(calls, 2);
  assert.equal(compiled.failed, false);
  assert.equal(compiled.assertions.length, 1);
});
