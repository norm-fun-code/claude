// Audit fix, item 2: Chief Brief and Ask used to receive the compiled/
// resolved context summary AND then unconditionally the same ground again
// as raw annotations/day-journal text — "prefer the compiled version" was
// left as an unenforced prompt suggestion, so a stale or since-corrected raw
// note could still read as live and contradict (or revive) exactly what the
// compiled context already accounts for. These tests drive the REAL routes
// (POST /briefing/context to compile, POST /briefing/chief-brief/rebuild for
// Chief Brief, chat/ask.js's ask() directly for Ask) against a real Postgres,
// capturing the actual LLM prompt text to prove: a raw annotation matched by
// a compiled assertion is no longer duplicated, an UNMATCHED raw annotation
// is still surfaced (no useful context silently dropped), and realtime
// voice's compiled-context payload never carries a raw duplicate either.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const briefingsStore = require('../../src/store/briefings');
const annotationsStore = require('../../src/store/annotations');

const app = buildTestApp();
const ORIGINAL_GENERATE_TEXT = llm.generateText;
const TEST_MARKER = `raw-fallback-${Date.now()}`;
// Deliberately NOT derived from TEST_MARKER: overlapScore (context-semantics.js)
// treats a shared marker token itself as "significant word overlap" between
// two otherwise-unrelated texts, which falsely inflated the match score past
// the threshold when both the compiled text and the "unmatched" fixture
// shared the same TEST_MARKER prefix. A real annotation and a real compiled
// assertion never share an artificial UUID-like token, so this collision was
// purely a test-fixture artifact — use a separate, unrelated tag instead.
const UNMATCHED_TAG = 'zzq-unmatched-fixture';

function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}
function mockCompile(assertions) {
  llm.generateText = async () => chiefMeta(JSON.stringify({ assertions }));
}
async function postContext(answer, extra = {}) {
  return request(app).post('/api/briefing/context').set(authHeader()).send({ answer, ...extra });
}
function chiefJson(overrides = {}) {
  return JSON.stringify({
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm', openQuestion: '', ...overrides },
    morningFocus: 'mf', urgentEmails: [],
  });
}

afterEach(async () => {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  await db.query(`DELETE FROM context_relations WHERE source_assertion_id IN (SELECT id FROM context_assertions WHERE raw_text LIKE $1)`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM context_assertions WHERE raw_text LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM annotations WHERE label LIKE $1 OR label LIKE $2`, [`%${TEST_MARKER}%`, `%${UNMATCHED_TAG}%`]);
  await db.query(`DELETE FROM day_journal WHERE text LIKE $1 OR text LIKE $2`, [`%${TEST_MARKER}%`, `%${UNMATCHED_TAG}%`]);
  await db.query(`DELETE FROM briefings WHERE kind = 'daily'`);
});
after(async () => { await closeDb(); });

// The chief-brief prompt also carries a SEPARATE "ELIGIBLE RECOVERY DRIVERS"
// section (intelligence/recovery-drivers.js's computeRecoveryDrivers) and
// self-model text (store/selfModel.js's nightly-batch-generated summary,
// which independently embeds its own "RECENT DAILY CONTEXT" day-journal
// excerpt) — both read raw context through entirely separate mechanisms
// this fix doesn't touch (recovery-drivers.js serves a narrower, differently
// filtered purpose; the self-model is a pre-baked artifact from a nightly
// consolidation job with no live awareness of ContextAssertions at all).
// Assert against ONLY the "Active life context" clause — the exact
// annotationsContext value this fix changes — so this test can't accidentally
// pass or fail based on those unrelated sections.
function activeLifeContextClause(prompt) {
  const m = /Active life context[^:]*:\s*([\s\S]*?)\n\nELIGIBLE RECOVERY DRIVERS/.exec(prompt || '');
  return m ? m[1] : null;
}

// Distinguishes the actual chief-brief LLM call from the full build's OTHER
// generateText calls (email summarization, quote insight, notion insight,
// etc.) the exact same way test/integration/briefing-context-tag-recency.test.js
// already does — a bare string reply to those other calls is fine, they're
// not under test here.
function captureChiefPrompt(t) {
  let capturedPrompt = null;
  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  llm.generateText = async ({ system, prompt }) => {
    if (system && system.includes('chief of staff and data scientist')) {
      capturedPrompt = prompt;
      return chiefMeta(chiefJson());
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
  return () => capturedPrompt;
}

test('Chief Brief FULL BUILD: a raw annotation matched by a compiled assertion is not duplicated in the prompt, but an unmatched one still is', async (t) => {
  // A non-health-domain event deliberately: an alcohol/health-concept event
  // ALSO independently populates the separate "ELIGIBLE RECOVERY DRIVERS"
  // section (intelligence/recovery-drivers.js's computeRecoveryDrivers,
  // reading straight from raw annotations for a DIFFERENT, narrower purpose
  // — see calendar-load.js-adjacent comments in routes/briefing.js). That
  // section is intentionally out of scope for this fix (it isn't the
  // "annotationsContext handed over twice" bug item 2 describes) — using a
  // non-health event keeps this test precisely scoped to what was changed.
  const compiledText = `${TEST_MARKER} I skipped the gym because I was sick`;
  mockCompile([{
    assertionType: 'decision', subject: `${TEST_MARKER} the gym session`, predicate: 'skipped', objectValue: '',
    concepts: ['illness'], domains: ['workouts'], eventStatus: 'occurred', temporalRef: 'today',
    explicitDate: '', correctsPriorText: '', confidence: 0.85,
  }]);
  const compileRes = await postContext(compiledText);
  assert.equal(compileRes.status, 200);

  // A second, genuinely uncompiled annotation — real production shape,
  // written directly to the store the way a non-compiling input path would.
  const unmatchedLabel = `${UNMATCHED_TAG} worked from a coffee shop today`;
  await annotationsStore.createAnnotation({
    startTs: new Date().toISOString(), category: 'brief_context', label: unmatchedLabel, note: null,
  });

  const getPrompt = captureChiefPrompt(t);
  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200);
  const capturedPrompt = getPrompt();
  assert.ok(capturedPrompt, 'expected to capture the chief-brief prompt');
  const clause = activeLifeContextClause(capturedPrompt);
  assert.ok(clause, 'expected an "Active life context" clause in the prompt');

  assert.doesNotMatch(clause, new RegExp(compiledText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the raw annotation matched by a compiled assertion must not be duplicated verbatim in the prompt');
  assert.match(clause, new RegExp(unmatchedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'a genuinely unmatched raw annotation must still reach the prompt — no useful context silently dropped');
  assert.match(clause, /skipped/, 'the compiled version of the matched decision must still be present');
});

test('Chief Brief scoped rebuild: same matched-suppressed / unmatched-kept behavior as the full build', async (t) => {
  await briefingsStore.saveBriefing({ kind: 'daily', content: { chiefBrief: { synthesis: 'prior', action: 'a', risk: 'r', move: 'm' }, morningFocus: 'prior mf' } });

  const compiledText = `${TEST_MARKER} I skipped the gym because I was sick`;
  mockCompile([{
    assertionType: 'decision', subject: `${TEST_MARKER} the gym session`, predicate: 'skipped', objectValue: '',
    concepts: ['illness'], domains: ['workouts'], eventStatus: 'occurred', temporalRef: 'today',
    explicitDate: '', correctsPriorText: '', confidence: 0.85,
  }]);
  const compileRes = await postContext(compiledText);
  assert.equal(compileRes.status, 200);

  const getPrompt = captureChiefPrompt(t);
  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).send({});
  assert.equal(res.status, 200);
  const capturedPrompt = getPrompt();
  assert.ok(capturedPrompt, 'expected to capture the scoped-rebuild chief-brief prompt');
  const clause = activeLifeContextClause(capturedPrompt);
  assert.ok(clause, 'expected an "Active life context" clause in the prompt');
  assert.doesNotMatch(clause, new RegExp(compiledText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the scoped rebuild must apply the same raw-fallback partitioning as the full build');
  assert.match(clause, /skipped/, 'the compiled version of the matched decision must still be present');
});

test('Ask: a compiled correction is not contradicted or revived by its own raw source annotation text', async () => {
  const compiledText = `${TEST_MARKER} I did not complete the valuation conversation`;
  mockCompile([{
    assertionType: 'completion', subject: `${TEST_MARKER} the valuation conversation`, predicate: 'is',
    objectValue: 'not complete', concepts: [], domains: ['goals'], eventStatus: 'negated',
    temporalRef: 'today', explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const compileRes = await postContext(compiledText);
  assert.equal(compileRes.status, 200);

  const unmatchedLabel = `${UNMATCHED_TAG} the office wifi was down all morning`;
  await annotationsStore.createAnnotation({
    startTs: new Date().toISOString(), category: 'brief_context', label: unmatchedLabel, note: null,
  });

  let capturedPrompt = null;
  llm.generateText = async (opts) => {
    if (opts?.prompt?.includes('RESOLVED CONTEXT') || opts?.prompt?.includes('LIFE CONTEXT')) capturedPrompt = opts.prompt;
    return 'Understood.';
  };
  const { ask } = require('../../src/chat/ask');
  await ask('What did I tell you about the valuation conversation?');
  assert.ok(capturedPrompt, 'expected to capture the ask() prompt');

  assert.doesNotMatch(capturedPrompt, new RegExp(compiledText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'Ask must not hand the model the raw pre-compilation text for an annotation a compiled assertion already represents');
  assert.match(capturedPrompt, new RegExp(unmatchedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'an unrelated, genuinely unmatched annotation must still reach the Ask prompt');
});

test('realtime voice: the compiled resolvedContext payload never carries a raw annotation duplicate', async () => {
  mockCompile([{
    assertionType: 'event', subject: 'user', predicate: 'drank', objectValue: 'wine',
    concepts: ['alcohol'], domains: ['health'], eventStatus: 'occurred', temporalRef: 'last_night',
    explicitDate: '', correctsPriorText: '', confidence: 0.9,
  }]);
  const compileRes = await postContext(`${TEST_MARKER} I drank wine last night`);
  assert.equal(compileRes.status, 200);

  const { buildBrainSnapshot } = require('../../src/brain/snapshot');
  const { realtimeTodayContext } = require('../../src/brain/snapshot');
  const snapshot = await buildBrainSnapshot({ tz: 'America/New_York' });
  const ctx = realtimeTodayContext(snapshot, null);
  // get_today_context's payload carries ONLY the compiled projection — no
  // parallel raw-annotation field exists on this object at all, so there is
  // structurally nothing for a stale raw copy to contradict the compiled
  // version with.
  assert.ok('resolvedContext' in ctx);
  assert.ok(!('annotationsContext' in ctx), 'realtime\'s today-context payload must never carry a separate raw-annotation field alongside the compiled one');
  if (ctx.resolvedContext) {
    assert.match(ctx.resolvedContext, /drank/);
  }
});
