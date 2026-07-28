// "What explains this?" — real-Postgres, production-path tests proving the
// full anomaly-context loop: eligibility, temporal binding to the anomaly's
// OWN observation date (never the answer date), duplicate-question
// suppression, skip/nothing-unusual/edit/forget semantics, and that the
// compiled explanation reaches the SAME canonical selectors Briefing/Ask
// read (context-resolver.js's getActiveOverlapping) with correct
// date/provenance. Mocks only the LLM extraction call, same pattern as
// test/integration/memory-history-separation.test.js.
'use strict';
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const contextAssertionsStore = require('../../src/store/contextAssertions');
const { localDayBoundsForYmd } = require('../../src/util/date');

const app = buildTestApp();
const ORIGINAL_GENERATE_TEXT = llm.generateText;
const TZ = process.env.TZ || 'America/New_York';
const TEST_MARKER = `anomctx${Date.now()}`;

function localDateStr(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
}
const TODAY = localDateStr(0);
const YESTERDAY = localDateStr(-1);
const STALE = localDateStr(-10);

function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}
function mockCompile(assertions) {
  llm.generateText = async () => chiefMeta(JSON.stringify({ assertions }));
}

function evidenceFor(dateStr, { metric = `health:${TEST_MARKER}`, domains = ['health'], ...overrides } = {}) {
  return {
    metric, domains,
    evidence: {
      auto: true, kind: 'anomaly', metric, date: dateStr, unit: 'kcal',
      anomalyKey: `anomaly:${metric}:${dateStr}`,
      latest: 211, baselineMean: 552.9, baselineStd: 60, z: -5.7, n: 30,
      ...overrides,
    },
  };
}

async function ensure(body) {
  return request(app).post('/api/anomaly-context/ensure').set(authHeader()).send(body);
}
async function answer(key, text) {
  return request(app).post(`/api/anomaly-context/${encodeURIComponent(key)}/answer`).set(authHeader()).send({ text });
}
async function nothingUnusual(key) {
  return request(app).post(`/api/anomaly-context/${encodeURIComponent(key)}/nothing-unusual`).set(authHeader());
}
async function skip(key) {
  return request(app).post(`/api/anomaly-context/${encodeURIComponent(key)}/skip`).set(authHeader());
}
async function forget(key) {
  return request(app).post(`/api/anomaly-context/${encodeURIComponent(key)}/forget`).set(authHeader());
}

afterEach(async () => {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  // anomaly_context_questions.context_assertion_id FKs into context_assertions
  // — delete the referencing row first or the FK constraint rejects the
  // context_assertions delete below.
  await db.query(`DELETE FROM anomaly_context_questions WHERE anomaly_key LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM context_relations WHERE source_assertion_id IN (SELECT id FROM context_assertions WHERE raw_text LIKE $1 OR source = 'anomaly_context')`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM context_assertions WHERE raw_text LIKE $1 OR (subject LIKE $1 OR object_value LIKE $1)`, [`%${TEST_MARKER}%`]);
});
after(async () => { await closeDb(); });

// ── required 1: a meaningful completed-data anomaly offers the optional question ──
test('required: a fresh anomaly for yesterday is eligible for the optional question', async () => {
  const body = evidenceFor(YESTERDAY);
  const res = await ensure(body);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'unanswered');
  assert.equal(res.body.eligible, true);
  assert.equal(res.body.anomalyKey, body.evidence.anomalyKey);
  assert.equal(res.body.unit, 'kcal');
});

// ── required 2: an anomaly for yesterday answered today binds the context to yesterday ──
test('required: answering today binds the explanation to the anomaly\'s own observation date (yesterday), never today', async () => {
  const body = evidenceFor(YESTERDAY);
  await ensure(body);
  mockCompile([{
    assertionType: 'event', subject: `${TEST_MARKER} travel`, predicate: 'was', objectValue: 'a travel day with little movement',
    concepts: ['travel'], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const res = await answer(body.evidence.anomalyKey, `${TEST_MARKER} I was traveling and sat on a train most of the day.`);
  assert.equal(res.status, 200);

  const yesterdayBounds = localDayBoundsForYmd(TZ, YESTERDAY);
  const todayBounds = localDayBoundsForYmd(TZ, TODAY);
  const overlappingYesterday = await contextAssertionsStore.getActiveOverlapping(yesterdayBounds.start, yesterdayBounds.end, { domains: ['health'] });
  const overlappingToday = await contextAssertionsStore.getActiveOverlapping(todayBounds.start, todayBounds.end, { domains: ['health'] });
  const found = overlappingYesterday.find((a) => a.rawText.includes(TEST_MARKER));
  assert.ok(found, 'the compiled assertion must be bound to yesterday, not today');
  assert.equal(found.source, 'anomaly_context');
  // ── required 11: the context does not leak into an unrelated (later) day ──
  assert.ok(!overlappingToday.some((a) => a.rawText.includes(TEST_MARKER)), 'must not leak into today');
});

// ── required 3: the answer survives app close/reopen (persisted in Postgres, re-readable) ──
test('required: the saved answer is durably re-readable (survives "reopen")', async () => {
  const body = evidenceFor(YESTERDAY);
  await ensure(body);
  mockCompile([{
    assertionType: 'event', subject: `${TEST_MARKER} rest`, predicate: 'was', objectValue: 'a planned rest day',
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await answer(body.evidence.anomalyKey, `${TEST_MARKER} It was a planned rest day.`);

  const reopened = await ensure(body); // idempotent re-fetch, as if the app reopened
  assert.equal(reopened.body.status, 'answered');
  assert.equal(reopened.body.rawAnswer, `${TEST_MARKER} It was a planned rest day.`);
});

// ── required 4: a rebuild does not repeat an answered question ──
test('required: re-ensuring after an answer does not re-offer the question', async () => {
  const body = evidenceFor(YESTERDAY);
  await ensure(body);
  mockCompile([{
    assertionType: 'state', subject: `${TEST_MARKER} watch`, predicate: 'was', objectValue: 'charging most of the day',
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await answer(body.evidence.anomalyKey, `${TEST_MARKER} My watch was charging.`);
  const rebuilt = await ensure(body);
  assert.equal(rebuilt.body.eligible, false, 'an answered anomaly must not be re-offered');
});

// ── required 5: skip persists and prevents repeated asking ──
test('required: skip persists and suppresses future eligibility', async () => {
  const body = evidenceFor(YESTERDAY);
  await ensure(body);
  const skipRes = await skip(body.evidence.anomalyKey);
  assert.equal(skipRes.status, 200);
  const rebuilt = await ensure(body);
  assert.equal(rebuilt.body.status, 'skipped');
  assert.equal(rebuilt.body.eligible, false);
});

// ── required 6: "nothing unusual" does not create a causal belief ──
test('required: "nothing unusual" is recorded but never compiled into a context_assertion', async () => {
  const body = evidenceFor(YESTERDAY);
  await ensure(body);
  let compileWasCalled = false;
  llm.generateText = async () => { compileWasCalled = true; return chiefMeta(JSON.stringify({ assertions: [] })); };
  const res = await nothingUnusual(body.evidence.anomalyKey);
  assert.equal(res.status, 200);
  assert.equal(compileWasCalled, false, 'the compiler must never be invoked for "nothing unusual"');

  const { rows } = await db.query(`SELECT status, raw_answer, context_assertion_id FROM anomaly_context_questions WHERE anomaly_key = $1`, [body.evidence.anomalyKey]);
  assert.equal(rows[0].status, 'answered');
  assert.equal(rows[0].raw_answer, 'Nothing unusual');
  assert.equal(rows[0].context_assertion_id, null, 'no durable belief/assertion may be created for "nothing unusual"');
});

// ── required 7: existing linked context suppresses a duplicate question ──
test('required: a pre-existing resolved context event for the same day/domain suppresses the question', async () => {
  mockCompile([{
    assertionType: 'event', subject: `${TEST_MARKER} sick`, predicate: 'was', objectValue: 'feeling under the weather',
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'yesterday',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  // Log unrelated day-journal context for yesterday through the SAME
  // production compiler pipeline other surfaces already use.
  await request(app).post('/api/briefing/context').set(authHeader()).send({ answer: `${TEST_MARKER} I was feeling sick yesterday` });

  const body = evidenceFor(YESTERDAY);
  const res = await ensure(body);
  assert.equal(res.body.eligible, false, 'an already-explained day/domain must not also prompt the anomaly question');
});

// ── required 8: stale/incomplete source data does not prompt for an explanation ──
test('required: a stale (10-day-old) observation date is never offered the question', async () => {
  const body = evidenceFor(STALE);
  const res = await ensure(body);
  assert.equal(res.status, 200);
  assert.equal(res.body.eligible, false);
});

// ── required 9: two UI representations of one anomaly share one stable anomaly ID and state ──
test('required: two independent /ensure calls for the same anomaly return the identical stable id and state', async () => {
  const body = evidenceFor(YESTERDAY);
  const first = await ensure(body);
  const second = await ensure(body); // simulates a second card/detail-view render
  assert.equal(first.body.anomalyKey, second.body.anomalyKey);
  assert.equal(first.body.status, second.body.status);
  assert.equal(first.body.eligible, second.body.eligible);
});

// ── required 10: the explanation reaches the same canonical selectors Briefing/Ask read, with matching date/provenance ──
test('required: the compiled explanation is visible via the canonical getActiveOverlapping selector with anomaly_context provenance', async () => {
  const body = evidenceFor(YESTERDAY);
  await ensure(body);
  mockCompile([{
    assertionType: 'event', subject: `${TEST_MARKER} train`, predicate: 'was', objectValue: 'a long train ride',
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await answer(body.evidence.anomalyKey, `${TEST_MARKER} Long train ride most of the day.`);

  const bounds = localDayBoundsForYmd(TZ, YESTERDAY);
  const overlapping = await contextAssertionsStore.getActiveOverlapping(bounds.start, bounds.end, { domains: ['health'] });
  const found = overlapping.find((a) => a.rawText.includes(TEST_MARKER));
  assert.ok(found);
  assert.equal(found.source, 'anomaly_context');
  assert.ok(new Date(found.effectiveStart) >= bounds.start && new Date(found.effectiveStart) <= bounds.end);
});

// ── required 12: editing and forgetting use canonical update/retirement behavior ──
test('required: editing retires the old assertion and links the new one; forgetting retires both', async () => {
  const body = evidenceFor(YESTERDAY);
  await ensure(body);
  mockCompile([{
    assertionType: 'event', subject: `${TEST_MARKER} first`, predicate: 'was', objectValue: 'first explanation',
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await answer(body.evidence.anomalyKey, `${TEST_MARKER} first explanation`);
  const { rows: r1 } = await db.query(`SELECT context_assertion_id FROM anomaly_context_questions WHERE anomaly_key = $1`, [body.evidence.anomalyKey]);
  const firstAssertionId = r1[0].context_assertion_id;
  assert.ok(firstAssertionId);

  mockCompile([{
    assertionType: 'event', subject: `${TEST_MARKER} second`, predicate: 'was', objectValue: 'second, corrected explanation',
    concepts: [], domains: ['health'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  await answer(body.evidence.anomalyKey, `${TEST_MARKER} second, corrected explanation`);
  const { rows: r2 } = await db.query(`SELECT context_assertion_id FROM anomaly_context_questions WHERE anomaly_key = $1`, [body.evidence.anomalyKey]);
  const secondAssertionId = r2[0].context_assertion_id;
  assert.notEqual(secondAssertionId, firstAssertionId);

  const firstAfterEdit = await contextAssertionsStore.getById(firstAssertionId);
  assert.ok(firstAfterEdit.retiredAt, 'editing must retire the prior assertion, never leave two live explanations');

  const forgetRes = await forget(body.evidence.anomalyKey);
  assert.equal(forgetRes.status, 200);
  const secondAfterForget = await contextAssertionsStore.getById(secondAssertionId);
  assert.ok(secondAfterForget.retiredAt, 'forgetting must retire the linked assertion');
  const { rows: r3 } = await db.query(`SELECT retired_at, status FROM anomaly_context_questions WHERE anomaly_key = $1`, [body.evidence.anomalyKey]);
  assert.ok(r3[0].retired_at, 'forgetting must retire the question row itself');

  const reAsked = await ensure(body);
  assert.equal(reAsked.body.eligible, true, 'a forgotten anomaly is fresh/re-askable again');
  assert.equal(reAsked.body.status, 'unanswered');
});

// ── required 13: no metric- or phrase-specific special cases — proven with a non-health domain ──
test('required: the same generic flow works for a non-health metric (wealth), with no special-cased logic', async () => {
  const body = evidenceFor(YESTERDAY, { metric: `wealth:${TEST_MARKER}`, domains: ['wealth'], unit: '$' });
  const res = await ensure(body);
  assert.equal(res.status, 200);
  assert.equal(res.body.eligible, true);
  assert.equal(res.body.unit, '$');

  mockCompile([{
    assertionType: 'event', subject: `${TEST_MARKER} wealth-event`, predicate: 'was', objectValue: 'an unusually large planned purchase',
    concepts: [], domains: ['wealth'], eventStatus: 'occurred', temporalRef: 'unspecified',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const answered = await answer(body.evidence.anomalyKey, `${TEST_MARKER} It was a planned large purchase.`);
  assert.equal(answered.status, 200);
});
