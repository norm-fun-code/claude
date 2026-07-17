// The repeated ONE QUESTION bug: answering the chief brief's openQuestion and
// then immediately tapping the Chief Brief scoped rebuild (or triggering a
// full rebuild) could bring the exact same question right back. Root causes
// (see intelligence/open-question-policy.js, routes/annotations.js, and
// routes/briefing.js):
//   1. The full build ran a deterministic dedup check but the scoped
//      chief-brief-only rebuild never did.
//   2. POST /briefing/context retired the question from cached builds via a
//      fire-and-forget call, racing an immediate rebuild.
//   3. The old check scanned recent 'brief_context' annotations for word
//      overlap — an unreliable substitute for a durable, purpose-built
//      "this question was answered" ledger.
// This exercises the REAL routes end-to-end (real DB-backed
// answered_open_questions ledger, real briefings cache, only the LLM
// stubbed) to prove every generation path enforces the same policy.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const briefingsStore = require('../../src/store/briefings');
const openQuestionsStore = require('../../src/store/openQuestions');
const annotationsStore = require('../../src/store/annotations');
const { localDateStr } = require('../../src/util/date');

const app = buildTestApp();
const ORIGINAL_GENERATE_TEXT = llm.generateText;
const ORIGINAL_CREATE_ANNOTATION = annotationsStore.createAnnotation;
const TZ = process.env.TZ || 'America/New_York';
const TODAY = localDateStr(TZ, new Date());
const YESTERDAY = localDateStr(TZ, new Date(Date.now() - 24 * 60 * 60 * 1000));

const Q1 = 'Are you scaling back the Q3 launch or pushing through?';
const Q1_PARAPHRASE = 'Are you scaling back the Q3 launch, or pushing through it?';
const Q_DIFFERENT = 'Did you take your magnesium last night?';

function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}
function chiefJson(openQuestion, overrides = {}) {
  return JSON.stringify({
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm', openQuestion, ...overrides },
    morningFocus: 'mf',
    urgentEmails: [],
  });
}
// Full-build LLM stub: routes both the chief-brief AND wisdom calls (they run
// concurrently — see routes/briefing.js's Promise.allSettled) based on the
// system prompt each carries.
function stubGenerateTextForFullBuild(openQuestion) {
  llm.generateText = async ({ system }) => {
    if (system && system.includes('chief of staff and data scientist')) return chiefMeta(chiefJson(openQuestion));
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
}

async function seedPriorDailyBriefing(openQuestion = '') {
  await briefingsStore.saveBriefing({
    kind: 'daily',
    content: {
      chiefBrief: { synthesis: 'prior', action: 'a', risk: 'r', move: 'm', openQuestion },
      morningFocus: 'prior mf',
    },
  });
}

async function answerOpenQuestion(question, answer = 'pushing through') {
  return request(app)
    .post('/api/briefing/context')
    .set(authHeader())
    .send({ question, answer, signalKey: 'brief_open_question' });
}

afterEach(async () => {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  annotationsStore.createAnnotation = ORIGINAL_CREATE_ANNOTATION;
  await db.query(`DELETE FROM briefings WHERE kind = 'daily'`);
  await db.query(`DELETE FROM answered_open_questions WHERE local_date IN ($1, $2)`, [TODAY, YESTERDAY]);
  await db.query(`DELETE FROM annotations WHERE note LIKE 'Q: %'`);
});
after(async () => { await closeDb(); });

test('answer -> immediate SCOPED rebuild -> the same question does not come back', async () => {
  await seedPriorDailyBriefing(Q1);
  const answerRes = await answerOpenQuestion(Q1);
  assert.equal(answerRes.status, 200);

  llm.generateText = async () => chiefMeta(chiefJson(Q1)); // model tries to ask it again
  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);
  assert.equal(res.status, 200);
  assert.equal(res.body.chiefBrief.openQuestion, '', 'the scoped rebuild must not resurface a just-answered question');
});

test('answer -> immediate FULL rebuild -> the same question does not come back', async () => {
  await seedPriorDailyBriefing(Q1);
  const answerRes = await answerOpenQuestion(Q1);
  assert.equal(answerRes.status, 200);

  stubGenerateTextForFullBuild(Q1); // model tries to ask it again
  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200);
  assert.equal(res.body.chiefBrief.openQuestion, '', 'the full build must not resurface a just-answered question');
});

test('a close paraphrase of an already-answered question is suppressed', async () => {
  await seedPriorDailyBriefing(Q1);
  const answerRes = await answerOpenQuestion(Q1);
  assert.equal(answerRes.status, 200);

  llm.generateText = async () => chiefMeta(chiefJson(Q1_PARAPHRASE));
  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);
  assert.equal(res.status, 200);
  assert.equal(res.body.chiefBrief.openQuestion, '', 'a close paraphrase about the same unresolved topic must also be suppressed');
});

test('a genuinely different question is NOT suppressed', async () => {
  await seedPriorDailyBriefing(Q1);
  const answerRes = await answerOpenQuestion(Q1);
  assert.equal(answerRes.status, 200);

  llm.generateText = async () => chiefMeta(chiefJson(Q_DIFFERENT));
  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);
  assert.equal(res.status, 200);
  assert.equal(res.body.chiefBrief.openQuestion, Q_DIFFERENT, 'an unrelated question must still surface');
});

test('a genuinely new occurrence of a similar question on a LATER day is NOT suppressed', async () => {
  // Simulate Q1 having been answered YESTERDAY (a different local date) —
  // directly via the store, since the route always records against "today".
  await openQuestionsStore.recordAnswered({
    localDate: YESTERDAY, questionText: Q1, fingerprint: 'x', topicKey: 'x', answer: 'handled yesterday',
  });
  await seedPriorDailyBriefing('');

  llm.generateText = async () => chiefMeta(chiefJson(Q1)); // today's model asks essentially the same thing
  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);
  assert.equal(res.status, 200);
  assert.equal(res.body.chiefBrief.openQuestion, Q1, 'only TODAY\'s answered ledger should suppress — a prior day\'s answer must not silence a fresh occurrence');
});

test('an annotation-creation failure after answering an open question leaves NO partial suppression state', async () => {
  await seedPriorDailyBriefing(Q1);
  annotationsStore.createAnnotation = async () => { throw new Error('simulated annotation failure'); };

  const res = await answerOpenQuestion(Q1, 'should not be durably suppressed');
  assert.notEqual(res.status, 200, 'a failed write must not report success');

  const answeredToday = await openQuestionsStore.answeredOn(TODAY);
  assert.ok(
    !answeredToday.some((a) => a.questionText === Q1),
    'the answered_open_questions row must be rolled back, not left as an orphaned suppression with no annotation to explain it'
  );

  const latest = await briefingsStore.latestBriefing('daily');
  assert.equal(
    latest.content.chiefBrief.openQuestion, Q1,
    'the cached build\'s openQuestion must also be rolled back to its original (unanswered) state, not left blanked'
  );
});

test('the response does not return before the answered-question retirement is durable', async () => {
  await seedPriorDailyBriefing(Q1);
  const res = await answerOpenQuestion(Q1);
  assert.equal(res.status, 200);

  // NO polling — everything (the ledger write, the annotation, the cached-
  // build blank) is awaited inside one transaction before the route
  // responds, so it must already be visible the instant this resolves.
  const answeredToday = await openQuestionsStore.answeredOn(TODAY);
  assert.ok(answeredToday.some((a) => a.questionText === Q1), 'the ledger write must be durable by response time');

  const latest = await briefingsStore.latestBriefing('daily');
  assert.equal(latest.content.chiefBrief.openQuestion, '', 'the cached build\'s openQuestion must already be blanked by response time');
});
