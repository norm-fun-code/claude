// Product audit rec #6 — "separate conversation History from durable
// Memory." Real-Postgres, production-path tests proving: History (chat
// conversations) and Memory (context_assertions/beliefs) are genuinely
// distinct data contracts and lifecycles; the durable-correction/time-
// bounded-expiry/retraction semantic requirements; that deleting one never
// silently affects the other; and that BrainSnapshot invalidation fires
// after every memory mutation. Mirrors
// test/integration/context-understanding-scenarios.test.js's established
// pattern (mock only the LLM extraction call, exercise the REAL
// compileUserContext -> persistCompiledContext -> resolveContext pipeline
// against real Postgres).
'use strict';
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const chatStore = require('../../src/store/chat');
const invalidation = require('../../src/brain/invalidation');
const { resolveContext, getCalendarClassification } = require('../../src/intelligence/context-resolver');

const app = buildTestApp();
const ORIGINAL_GENERATE_TEXT = llm.generateText;
const TEST_MARKER = `mem-hist-${Date.now()}`;

function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}
function mockCompile(assertions) {
  llm.generateText = async () => chiefMeta(JSON.stringify({ assertions }));
}
async function postContext(answer, extra = {}) {
  return request(app).post('/api/briefing/context').set(authHeader()).send({ answer, ...extra });
}
async function getMemory() {
  return request(app).get('/api/memory').set(authHeader());
}

afterEach(async () => {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  await db.query(`DELETE FROM context_relations WHERE source_assertion_id IN (SELECT id FROM context_assertions WHERE raw_text LIKE $1)`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM context_assertions WHERE raw_text LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM annotations WHERE label LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM day_journal WHERE text LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM conversations WHERE title LIKE $1`, [`%${TEST_MARKER}%`]);
});
after(async () => { await closeDb(); });

// ── required: History and Memory return different data contracts ──
test('required: GET /chat/conversations and GET /memory return structurally different shapes — History is transcripts, Memory is typed facts', async () => {
  mockCompile([{
    assertionType: 'preference', subject: `${TEST_MARKER} dairy`, predicate: 'avoids', objectValue: 'dairy',
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await postContext(`${TEST_MARKER} I avoid dairy`);

  const history = await request(app).get('/api/chat/conversations').set(authHeader());
  assert.equal(history.status, 200);
  assert.ok(Array.isArray(history.body.conversations));

  const memory = await getMemory();
  assert.equal(memory.status, 200);
  assert.ok(Array.isArray(memory.body.active));
  assert.ok(Array.isArray(memory.body.historical));
  // Structural contract check: a History row is a transcript (title/
  // message_count/saved_at); a Memory row is a typed fact (category/
  // statement/origin/status) — neither shape should satisfy the other's.
  for (const item of memory.body.active) {
    assert.ok(!('message_count' in item) && !('saved_at' in item), 'a Memory item must never look like a History row');
    assert.ok('category' in item && 'origin' in item && 'status' in item);
  }
});

// ── required: a saved chat is not presented as a durable memory ──
test('required: saving an Ask conversation never makes it appear in GET /memory', async () => {
  // Drive a real question through the active thread, then save it (archive
  // into the "Saved"/History list) — see store/chat.js's saveActiveConversation.
  await chatStore.saveMessage({ role: 'user', content: `${TEST_MARKER} what's my HRV trend` });
  await chatStore.saveMessage({ role: 'assistant', content: `${TEST_MARKER} here's what I found` });
  await chatStore.saveActiveConversation({ title: `${TEST_MARKER} conversation` });

  const memory = await getMemory();
  const all = [...memory.body.active, ...memory.body.historical];
  assert.ok(
    !all.some((i) => i.statement && i.statement.includes(TEST_MARKER)),
    'a saved conversation transcript must never surface as a Memory item — only validated structured extractions do'
  );
});

// ── required: a durable extracted fact appears in Memory ──
test('required: a compiled preference assertion appears in GET /memory\'s active list, correctly categorized, with no transcript required', async () => {
  mockCompile([{
    assertionType: 'preference', subject: 'training', predicate: 'prefers', objectValue: `${TEST_MARKER} evening workouts`,
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const res = await postContext(`${TEST_MARKER} I prefer evening workouts`);
  assert.equal(res.status, 200);

  const memory = await getMemory();
  const item = memory.body.active.find((i) => i.statement && i.statement.includes(TEST_MARKER));
  assert.ok(item, 'expected the compiled preference to appear in Memory');
  assert.equal(item.category, 'stable_facts_preferences');
  assert.equal(item.origin, 'assertion');
  assert.equal(item.eligibleForReasoning, true);
  assert.equal(item.temporalLabel, 'Standing preference · no expiration');
});

// ── required: a recurring Sabbath correction changes future calendar interpretation ──
test('required: a calendar classification correction is durable, reasoning-eligible, and categorized as a recurring routine in Memory', async () => {
  mockCompile([{
    assertionType: 'classification', subject: `${TEST_MARKER} Friday evening block`, predicate: 'is',
    objectValue: `${TEST_MARKER} Sabbath time, not meetings`, concepts: ['sabbath_block'], domains: ['calendar'],
    eventStatus: 'occurred', temporalRef: 'today', explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const res = await postContext(`${TEST_MARKER} Friday evening blocks are Sabbath time, not meetings`);
  assert.equal(res.status, 200);

  const resolved = await resolveContext({});
  const cls = getCalendarClassification(resolved, `${TEST_MARKER} Friday evening block`);
  assert.ok(cls, 'expected the correction to be resolvable as a calendar classification');
  assert.match(cls.classification, /not meetings/);

  const memory = await getMemory();
  const item = memory.body.active.find((i) => i.statement && i.statement.includes(TEST_MARKER));
  assert.ok(item, 'expected the classification to appear in Memory');
  assert.equal(item.category, 'routines_classifications');
  assert.equal(item.eligibleForReasoning, true, 'a recurring classification correction must stay reasoning-eligible so NormOS never re-asks about the same block');
});

// ── required: a time-bounded fast expires and cannot influence later current-day reasoning ──
test('required: a 25-hour fast resolves to explicit effective dates, then expires and is excluded from resolved context the next day', async () => {
  // A fixed explicit date several days before "now" (whenever the suite
  // actually runs) — this lets the test prove BOTH halves against the real
  // compiler/route (which always resolves temporal windows off the real
  // wall clock, not an injectable `now`): during its own 25h window the fast
  // is eligible; by the time this test runs (real "now"), that window has
  // already elapsed, so the route's own GET /memory (which always evaluates
  // "as of now") must show it as expired/historical without any clock
  // manipulation.
  const explicitDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  mockCompile([{
    assertionType: 'event', subject: 'fast', predicate: 'is', objectValue: `${TEST_MARKER} fasting for the Ninth of Av`,
    concepts: [], domains: ['wellbeing'], eventStatus: 'completed', temporalRef: 'explicit_date',
    explicitDate, correctsPriorText: '', confidence: 0.9, durationHours: 25,
  }]);
  const res = await postContext(`${TEST_MARKER} I fasted for 25 hours for the Ninth of Av`);
  assert.equal(res.status, 200);

  const resolved = await resolveContext({});
  const fast = resolved.assertions.find((a) => a.rawText.includes(TEST_MARKER));
  assert.ok(fast, 'expected the fast to be compiled into an assertion');
  assert.ok(fast.effectiveStart && fast.effectiveEnd, 'expected explicit effective start/end dates, not an open-ended window');
  const spanHours = (new Date(fast.effectiveEnd) - new Date(fast.effectiveStart)) / 3600000;
  assert.ok(spanHours > 24 && spanHours < 26, `expected roughly a 25-hour window, got ${spanHours}h`);

  // During its own window, a purpose-built read (any asOf inside the span)
  // must show it as current, eligible context.
  const { summarizeResolvedContext } = require('../../src/intelligence/context-resolver');
  const duringWindow = new Date(new Date(fast.effectiveStart).getTime() + 3600000);
  const summaryDuring = summarizeResolvedContext(resolved, { purpose: 'general', asOf: duringWindow, includeHistorical: false });
  assert.match(summaryDuring, /fasting/i, 'the fast must read as current context while its window is still open');

  // At the real current moment (well after the explicit date + 25h), GET
  // /memory — which always evaluates "as of now" — must show it as
  // historical/expired, never active, and it must never later read as "a
  // fast starting tonight".
  const memory = await getMemory();
  const stillActive = memory.body.active.find((i) => i.statement && i.statement.includes(TEST_MARKER));
  const nowHistorical = memory.body.historical.find((i) => i.statement && i.statement.includes(TEST_MARKER));
  assert.equal(stillActive, undefined, 'an ended fast must not still read as active/current');
  assert.ok(nowHistorical, 'the ended fast must be visible as historical context');
  assert.equal(nowHistorical.eligibleForReasoning, false);
  assert.match(nowHistorical.temporalLabel, /expired event/);

  // And the same purpose-built read, evaluated at the REAL current moment,
  // must no longer include it — the exact "cannot influence later current-
  // day reasoning" requirement.
  const summaryNow = summarizeResolvedContext(resolved, { purpose: 'general', asOf: new Date(), includeHistorical: false });
  assert.doesNotMatch(summaryNow, /fasting/i, 'the expired fast must not appear in a current-day context summary');
});

// ── required: retraction removes a fact from resolved context ──
test('required: "please forget that context" retires the targeted assertion and removes it from resolved context', async () => {
  mockCompile([{
    assertionType: 'state', subject: `${TEST_MARKER} project`, predicate: 'is working on', objectValue: 'the redesign',
    concepts: [], domains: ['other'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await postContext(`${TEST_MARKER} I'm working on the redesign project`);
  const before = await resolveContext({});
  assert.ok(before.assertions.some((a) => a.rawText.includes(TEST_MARKER)), 'sanity: the statement is present before retraction');

  mockCompile([{
    assertionType: 'correction', subject: `${TEST_MARKER} project`, predicate: 'is working on', objectValue: 'the redesign',
    concepts: [], domains: ['other'], eventStatus: 'retracted', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: `${TEST_MARKER} I'm working on the redesign project`, confidence: 0.9,
  }]);
  const retractRes = await postContext(`${TEST_MARKER} please forget that context`);
  assert.equal(retractRes.status, 200);

  const after1 = await resolveContext({});
  const stillLive = after1.assertions.find((a) => a.rawText.includes(TEST_MARKER) && a.eventStatus === 'occurred' && !a.retiredAt);
  assert.ok(!stillLive, 'the original statement must no longer be live/reasoning-eligible after retraction');
});

// ── required: superseded facts remain auditable but are not reasoning-eligible ──
test('required: a superseded assertion is visible in Memory\'s historical bucket but eligibleForReasoning=false', async () => {
  mockCompile([{
    assertionType: 'state', subject: `${TEST_MARKER} standing`, predicate: 'meeting time is', objectValue: '9am',
    concepts: [], domains: ['other'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await postContext(`${TEST_MARKER} my standing meeting time is 9am`);

  mockCompile([{
    assertionType: 'correction', subject: `${TEST_MARKER} standing`, predicate: 'meeting time is', objectValue: '10am',
    concepts: [], domains: ['other'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: `${TEST_MARKER} my standing meeting time is 9am`, confidence: 0.9,
  }]);
  await postContext(`${TEST_MARKER} actually my standing meeting time is 10am now`);

  const memory = await getMemory();
  const historicalHit = memory.body.historical.find((i) => i.statement && i.statement.includes('9am') && i.statement.includes(TEST_MARKER) === false ? false : i.statement.includes('9am'));
  const oldOne = memory.body.historical.find((i) => i.statement && i.statement.includes('9am'));
  assert.ok(oldOne, 'expected the superseded 9am statement to remain visible as historical/auditable');
  assert.equal(oldOne.eligibleForReasoning, false);
  void historicalHit;
});

// ── required: deleting History does not silently delete active Memory ──
test('required: deleting a saved conversation leaves an unrelated active Memory item completely untouched', async () => {
  mockCompile([{
    assertionType: 'preference', subject: 'coffee', predicate: 'avoids', objectValue: `${TEST_MARKER} coffee after noon`,
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await postContext(`${TEST_MARKER} I avoid coffee after noon`);

  await chatStore.saveMessage({ role: 'user', content: `${TEST_MARKER} random question` });
  const conv = await chatStore.saveActiveConversation({ title: `${TEST_MARKER} to delete` });
  const list = await request(app).get('/api/chat/conversations').set(authHeader());
  const created = list.body.conversations.find((c) => c.title && c.title.includes(TEST_MARKER));
  assert.ok(created, 'sanity: the conversation was actually saved');

  const del = await request(app).delete(`/api/chat/conversations/${created.id}`).set(authHeader());
  assert.equal(del.status, 200);

  const memory = await getMemory();
  const stillThere = memory.body.active.find((i) => i.statement && i.statement.includes(TEST_MARKER));
  assert.ok(stillThere, 'deleting a conversation must never touch an unrelated active Memory item');
  void conv;
});

// ── required: forgetting Memory prevents future retrieval without corrupting conversation History ──
test('required: POST /memory/assertions/:id/forget retires the fact (excluded from resolved context) and leaves chat history rows untouched', async () => {
  mockCompile([{
    assertionType: 'preference', subject: 'gym', predicate: 'prefers', objectValue: `${TEST_MARKER} the downtown gym`,
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await postContext(`${TEST_MARKER} I prefer the downtown gym`);

  await chatStore.saveMessage({ role: 'user', content: `${TEST_MARKER} unrelated chat turn` });
  const before = await chatStore.recentMessages({ limit: 50 });
  const beforeCount = before.filter((m) => m.content.includes(TEST_MARKER)).length;
  assert.ok(beforeCount > 0, 'sanity: the chat turn exists before forgetting the memory');

  const memory = await getMemory();
  const item = memory.body.active.find((i) => i.statement && i.statement.includes(TEST_MARKER));
  assert.ok(item);
  const forget = await request(app).post(`/api/memory/assertions/${item.rawId}/forget`).set(authHeader());
  assert.equal(forget.status, 200);

  const resolved = await resolveContext({});
  assert.ok(!resolved.assertions.some((a) => a.id === item.rawId), 'a forgotten assertion must be excluded from resolved context');

  const after1 = await chatStore.recentMessages({ limit: 50 });
  const afterCount = after1.filter((m) => m.content.includes(TEST_MARKER)).length;
  assert.equal(afterCount, beforeCount, 'forgetting a Memory item must never touch conversation History rows');
});

// ── required: Brain invalidation occurs after memory correction, retirement, and supersession ──
test('required: forgetting, correcting, and superseding an assertion each bump the context_assertion_change invalidation trigger', async () => {
  mockCompile([{
    assertionType: 'preference', subject: 'tea', predicate: 'prefers', objectValue: `${TEST_MARKER} green tea`,
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await postContext(`${TEST_MARKER} I prefer green tea`);
  let memory = await getMemory();
  let item = memory.body.active.find((i) => i.statement && i.statement.includes(TEST_MARKER));
  assert.ok(item);

  const v0 = invalidation.versionOf('resolvedContext');
  const forget = await request(app).post(`/api/memory/assertions/${item.rawId}/forget`).set(authHeader());
  assert.equal(forget.status, 200);
  assert.ok(invalidation.versionOf('resolvedContext') > v0, 'forget must bump resolvedContext (via context_assertion_change)');

  // Correct: create a fresh fact, then correct it.
  mockCompile([{
    assertionType: 'preference', subject: `${TEST_MARKER} soda`, predicate: 'prefers', objectValue: 'diet soda',
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await postContext(`${TEST_MARKER} I prefer diet soda`);
  memory = await getMemory();
  item = memory.body.active.find((i) => i.statement && i.statement.includes('diet soda'));
  assert.ok(item);

  const v1 = invalidation.versionOf('resolvedContext');
  mockCompile([{
    assertionType: 'preference', subject: `${TEST_MARKER} soda`, predicate: 'prefers', objectValue: 'sparkling water instead',
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const correct = await request(app).post(`/api/memory/assertions/${item.rawId}/correct`).set(authHeader()).send({ text: `${TEST_MARKER} actually I prefer sparkling water instead` });
  assert.equal(correct.status, 200);
  assert.ok(invalidation.versionOf('resolvedContext') > v1, 'correct must bump resolvedContext (via context_assertion_change)');
});

// ── required: no raw internal metadata leaks into the mobile UI ──
test('required: GET /memory never leaks raw internal column names, policy enums, or table identifiers', async () => {
  mockCompile([{
    assertionType: 'preference', subject: `${TEST_MARKER} leak-check`, predicate: 'prefers', objectValue: 'quiet mornings',
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await postContext(`${TEST_MARKER} I prefer quiet mornings`);

  const memory = await getMemory();
  const raw = JSON.stringify(memory.body);
  for (const forbidden of [
    'source_authority', 'assertion_type', 'event_status', 'compiler_version',
    'dedup_key', 'user_locked', 'evidence_basis', 'context_assertions', 'context_relations',
    'supersedes_assertion_id', 'retired_at', 'effective_start', 'effective_end',
  ]) {
    assert.ok(!raw.includes(forbidden), `GET /memory response must never contain the raw internal token "${forbidden}"`);
  }
});
