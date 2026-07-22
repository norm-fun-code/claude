// Integration coverage for the temporal-grounding fix's cross-cutting
// requirements that need a real Postgres + the real HTTP surface:
//  - required test 7: full build and scoped Chief Brief rebuild receive
//    IDENTICAL canonical temporal facts (both read the same
//    intelligence/nightly-context-history.js authority).
//  - required test 8: POST /api/context's durable invalidation fires EXACTLY
//    ONCE after a successful write, and not at all on a failed write.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const metricsStore = require('../../src/store/metrics');
const sourcesStore = require('../../src/store/sources');
const { naiveToUtcIso } = require('../../src/util/date');
const { computeNightlyContextHistory, renderNightlyContextHistoryPrompt } = require('../../src/intelligence/nightly-context-history');

const app = buildTestApp();
const TZ = process.env.TZ || 'America/New_York';

function localDayString(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 864e5);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

async function seedLateMeal(daysAgo) {
  await sourcesStore.registerSource({ id: 'self_report', domain: 'health', displayName: 'Self-reported' }).catch(() => {});
  const dayStr = localDayString(daysAgo);
  await metricsStore.insertMetrics([
    { ts: new Date(naiveToUtcIso(`${dayStr}T12:00:00`, TZ)), domain: 'context', metric: 'late_meal', value: 1, unit: 'bool', source: 'self_report' },
  ]);
}

function captureChiefPrompt(t) {
  let capturedPrompt = null;
  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  llm.generateText = async ({ system, prompt }) => {
    if (system.includes('chief of staff and data scientist')) {
      capturedPrompt = prompt;
      return {
        text: JSON.stringify({
          chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm', openQuestion: '' },
          morningFocus: 'f', urgentEmails: [],
        }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
  return () => capturedPrompt;
}

function extractRecentContextTagsBlock(prompt) {
  // The block runs from its header to the first blank line (every prompt
  // section in buildChiefBriefPrompt is separated by \n\n) — non-greedy so
  // this stops at the FIRST blank line, not the last one in the prompt.
  const m = /RECENT CONTEXT TAGS[\s\S]*?(?=\n\n)/.exec(prompt || '');
  return m ? m[0].trim() : null;
}

afterEach(async () => {
  await db.query(`DELETE FROM metrics WHERE domain = 'context' AND metric = 'late_meal' AND ts >= now() - interval '10 days'`);
});
after(async () => { await closeDb(); });

test('required test 7: full build and scoped Chief Brief rebuild render the IDENTICAL RECENT CONTEXT TAGS block', async (t) => {
  await seedLateMeal(2);

  const getPrompt = captureChiefPrompt(t);
  const fullRes = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(fullRes.status, 200);
  const fullBlock = extractRecentContextTagsBlock(getPrompt());
  assert.ok(fullBlock, 'full build must render a RECENT CONTEXT TAGS block');

  const scopedRes = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);
  assert.equal(scopedRes.status, 200);
  const scopedBlock = extractRecentContextTagsBlock(getPrompt());
  assert.ok(scopedBlock, 'scoped rebuild must render a RECENT CONTEXT TAGS block');

  assert.equal(scopedBlock, fullBlock, 'full build and scoped rebuild must present IDENTICAL canonical temporal facts');
  assert.match(fullBlock, /Late meal: occurred on 1 of the last 3 completed nights; latest occurrence was the night ending [A-Za-z]+ \d+ \(2 nights ago\)\./);

  // And both must match the SAME canonical authority computed directly.
  const direct = renderNightlyContextHistoryPrompt(await computeNightlyContextHistory({ tz: TZ }));
  assert.equal(fullBlock, direct.trim());
});

test('required test 8: POST /api/context invalidates nightlyContextHistory exactly once after a successful write', async (t) => {
  const { bumpDurable, TRIGGER } = require('../../src/brain/invalidation');
  let calls = [];
  const original = require('../../src/brain/invalidation').bumpDurable;
  const invalidationModule = require('../../src/brain/invalidation');
  invalidationModule.bumpDurable = async (trigger, meta) => {
    calls.push(trigger);
    return original(trigger, meta);
  };
  t.after(() => { invalidationModule.bumpDurable = original; });

  const res = await request(app)
    .post('/api/context')
    .set(authHeader())
    .send({ active: { late_meal: true }, submitted: true });
  assert.equal(res.status, 200);

  const contextTagCalls = calls.filter((c) => c === TRIGGER.CONTEXT_TAG_CHANGE);
  assert.equal(contextTagCalls.length, 1, 'exactly one invalidation per successful POST /api/context');
});

test('required test 8b: a failed metrics write never invalidates (no bump before/without a successful commit)', async (t) => {
  const metricsStoreMod = require('../../src/store/metrics');
  const originalInsert = metricsStoreMod.insertMetrics;
  metricsStoreMod.insertMetrics = async () => { throw new Error('simulated write failure'); };
  t.after(() => { metricsStoreMod.insertMetrics = originalInsert; });

  const invalidationModule = require('../../src/brain/invalidation');
  const originalBump = invalidationModule.bumpDurable;
  let bumpCalled = false;
  invalidationModule.bumpDurable = async (...args) => { bumpCalled = true; return originalBump(...args); };
  t.after(() => { invalidationModule.bumpDurable = originalBump; });

  const res = await request(app)
    .post('/api/context')
    .set(authHeader())
    .send({ active: { late_meal: true }, submitted: true });
  assert.equal(res.status, 500, 'the write failure must propagate as an error, not a silent success');
  assert.equal(bumpCalled, false, 'a failed write must never trigger an invalidation');
});
