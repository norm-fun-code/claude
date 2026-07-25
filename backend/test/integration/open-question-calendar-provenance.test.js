// Audit fix: the Chief Brief's OWN freeform openQuestion ("You have 9 hours
// of meetings today...") had no server-side identity at all — mobile echoed
// back only the raw question TEXT, so an answer like "It's a Sabbath block,
// not actual meetings" had nothing reliable to bind to. This is the
// production-path coverage for the fix: a server-owned canonical question
// instance (store/openQuestionInstances.js), minted deterministically at
// generation time (intelligence/open-question-subject.js's
// detectCalendarLoadSubject — see test/open-question-subject.test.js for its
// own unit coverage), and an atomic, fail-closed answer path in
// routes/annotations.js.
//
// Real Postgres, real routes throughout; only the LLM extraction calls are
// mocked (no live Anthropic access in this environment) — same established
// pattern as context-lifecycle-and-question-provenance.test.js.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const briefingsStore = require('../../src/store/briefings');
const openQuestionInstancesStore = require('../../src/store/openQuestionInstances');
const openQuestionsStore = require('../../src/store/openQuestions');
const { calendarBlockId } = require('../../src/intelligence/calendar-block-identity');
const { resolveContext, matchCalendarClassifications } = require('../../src/intelligence/context-resolver');
const { computeCalendarLoad } = require('../../src/intelligence/calendar-load');

const app = buildTestApp();
const TZ = 'America/New_York';
const ORIGINAL_GENERATE_TEXT = llm.generateText;
const TEST_MARKER = `open-q-cal-${Date.now()}`;

function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}
function mockCompileClassification({ objectValue, evidenceSpan }) {
  llm.generateText = async () => chiefMeta(JSON.stringify({
    assertions: [{
      assertionType: 'classification', subject: `${TEST_MARKER} block`, predicate: 'is', objectValue,
      concepts: ['sabbath_block'], domains: ['calendar'], eventStatus: 'occurred', temporalRef: 'unspecified',
      explicitDate: '', correctsPriorText: '', evidenceSpan, confidence: 0.9,
      durationHours: 0, explicitEndDate: '', polarity: 'neutral',
    }],
  }));
}
function mockCompileThrows(message = 'simulated compiler outage') {
  llm.generateText = async () => { throw new Error(message); };
}
// Full-build/scoped-rebuild chief-brief stub: routes on the system prompt,
// same convention as open-question-suppression.test.js.
// Fields are long enough to clear assessChiefBriefQuality's
// minimum-completeness bar (synthesis >= 12 words, action/risk/move >= 4,
// morningFocus >= 15 when present) — since a scoped rebuild that fails the
// quality bar no longer replaces the existing card (audit fix, item B), bare
// single-letter placeholders would silently keep the prior card and this
// file's questionId/openQuestion assertions would fail against stale data.
function stubChiefBrief(openQuestion) {
  llm.generateText = async ({ system } = {}) => {
    if (system && system.includes('chief of staff and data scientist')) {
      return chiefMeta(JSON.stringify({
        chiefBrief: {
          synthesis: 'Today is on track with a heavy but manageable meeting load overall.',
          action: 'Block a short buffer before the next meeting to reset and refocus.',
          risk: 'Back-to-back meetings could leave no room for the actual follow-up work.',
          move: 'Confirm which meetings are essential and decline or shorten the rest.',
          openQuestion,
        },
        morningFocus: 'Take a quiet moment before the day starts to plan around today\'s heavier meeting load.',
        urgentEmails: [],
      }));
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
}

async function seedInstance(overrides = {}) {
  return openQuestionInstancesStore.create({
    localDate: '2026-08-10',
    questionText: `${TEST_MARKER} You have 9.0 hours of meetings today — anything driving that?`,
    fingerprint: 'test-fp', topicKey: 'test-topic',
    subjectType: 'calendar_load', subjectLocalDate: '2026-08-10', subjectBlockIds: [], subjectAmbiguous: false,
    ...overrides,
  });
}

afterEach(async () => {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  await db.query(`DELETE FROM context_relations WHERE source_assertion_id IN (SELECT id FROM context_assertions WHERE raw_text LIKE $1)`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM context_assertions WHERE raw_text LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM annotations WHERE label LIKE $1 OR note LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM answered_open_questions WHERE question_text LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM open_question_instances WHERE question_text LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM briefings WHERE kind = 'daily'`);
});
after(async () => { await closeDb(); });

// ── Scenarios 1 & 6 — real generation, real answer, real rebuild-no-reask ──
test('scenarios 1 & 6 — Chief Brief mints a canonical instance for a calendar-load openQuestion; answering it excludes the titleless block from canonical load, and a rebuild does not re-ask it', async () => {
  const start = '9:00 AM', end = '6:00 PM'; // 9h, titleless
  // The scoped-rebuild generation path only supports binding a TODAY
  // subject (see open-question-policy.js's scoped-rebuild call site) — the
  // work-busy block's own `date` must be REAL today for the deterministic
  // subject detector's contributing-block match to land on the same date
  // it stamps onto the minted instance.
  const workBusyDate = require('../../src/util/date').localDateStr(TZ, new Date());
  const id = calendarBlockId({ source: 'work_busy', date: workBusyDate, start, end });
  const workBusy = [{ start, end, date: workBusyDate, id }];

  await briefingsStore.saveBriefing({
    kind: 'daily',
    content: {
      chiefBrief: { synthesis: 'prior', action: 'a', risk: 'r', move: 'm', openQuestion: '' },
      morningFocus: 'prior mf', calendar: [], workBusy,
    },
  });

  const openQuestionText = `${TEST_MARKER} You have 9.0 hours of meetings today — anything specific driving that, or just a heavy week?`;
  stubChiefBrief(openQuestionText);

  const rebuildRes = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);
  assert.equal(rebuildRes.status, 200);
  assert.equal(rebuildRes.body.chiefBrief.openQuestion, openQuestionText);
  const questionId = rebuildRes.body.chiefBrief.openQuestionId;
  assert.ok(questionId, 'a server-owned canonical instance id must be minted for a surviving openQuestion');

  const instance = await openQuestionInstancesStore.getById(questionId);
  assert.ok(instance, 'the instance must be durably persisted');
  assert.equal(instance.subjectType, 'calendar_load', 'the deterministic subject detector must recognize this as a calendar-load question');
  assert.deepEqual(instance.subjectBlockIds, [id], 'must bind to the exact titleless block that produced the cited figure');
  assert.equal(instance.subjectAmbiguous, false);

  mockCompileClassification({
    objectValue: 'a Sabbath observance, not meetings',
    evidenceSpan: `${TEST_MARKER} it's a Sabbath block, not actual meetings`,
  });
  const answerRes = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: openQuestionText,
    answer: `${TEST_MARKER} it's a Sabbath block, not actual meetings`,
    signalKey: 'brief_open_question',
    questionId,
  });
  assert.equal(answerRes.status, 200, `expected a durable semantic write to succeed: ${JSON.stringify(answerRes.body)}`);

  // Downstream: the exact block is excluded from canonical meeting load —
  // proven from a completely fresh Postgres read, exactly as a rebuild would see.
  const resolved = await resolveContext({ tz: TZ });
  const overrides = matchCalendarClassifications(resolved, { calendar: [], workBusy, targetLocalDate: workBusyDate });
  assert.equal(overrides.length, 1, 'the classification must resolve to exactly the described block via stable identity');
  const load = computeCalendarLoad({ workBusy, calendar: [], classifiedOverrides: overrides });
  assert.equal(load.meetingHours, 0, "the day's canonical meeting load must exclude the classified titleless block entirely");

  const answeredRow = await openQuestionInstancesStore.getById(questionId);
  assert.ok(answeredRow.answeredAt, 'the instance must be stamped answered atomically with the classification');

  // Scenario 6 — an immediate rebuild that tries to ask the SAME question
  // again must not resurface it (existing answered_open_questions ledger,
  // unaffected by this fix, still enforces this).
  stubChiefBrief(openQuestionText);
  const secondRebuild = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);
  assert.equal(secondRebuild.status, 200);
  assert.equal(secondRebuild.body.chiefBrief.openQuestion, '', 'a rebuild must not re-ask the just-answered question');
  assert.equal(secondRebuild.body.chiefBrief.openQuestionId, null, 'a suppressed question must not carry a stale/reusable id');
});

// ── Scenario 2 — answered a different day than the subject it describes ────
test('scenario 2 — the classification binds to the subject date the question was asked ABOUT, independent of when it is answered', async () => {
  const SUBJECT_DATE = '2026-08-21'; // "tomorrow" relative to whenever the question was generated
  const OTHER_DATE = '2026-08-22'; // a different day — must NOT be affected
  const start = '10:00 AM', end = '7:00 PM';
  const id = calendarBlockId({ source: 'work_busy', date: SUBJECT_DATE, start, end });
  const workBusy = [{ start, end, date: SUBJECT_DATE, id }];

  const questionId = await seedInstance({
    questionText: `${TEST_MARKER} Tomorrow's work calendar is heavily blocked (9.0h) — anything specific driving it?`,
    subjectLocalDate: SUBJECT_DATE, subjectBlockIds: [id],
  });

  mockCompileClassification({
    objectValue: 'a Sabbath observance, not meetings',
    evidenceSpan: `${TEST_MARKER} it's a Sabbath block, not actual meetings`,
  });
  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: `${TEST_MARKER} Tomorrow's work calendar is heavily blocked (9.0h) — anything specific driving it?`,
    answer: `${TEST_MARKER} it's a Sabbath block, not actual meetings`,
    signalKey: 'brief_open_question',
    questionId,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const resolved = await resolveContext({ tz: TZ });
  const onSubjectDate = matchCalendarClassifications(resolved, { calendar: [], workBusy, targetLocalDate: SUBJECT_DATE });
  assert.equal(onSubjectDate.length, 1, 'the classification must apply on the date the question actually described');

  const otherWorkBusy = [{ start, end, date: OTHER_DATE, id: calendarBlockId({ source: 'work_busy', date: OTHER_DATE, start, end }) }];
  const onOtherDate = matchCalendarClassifications(resolved, { calendar: [], workBusy: otherWorkBusy, targetLocalDate: OTHER_DATE });
  assert.equal(onOtherDate.length, 0, 'a different day\'s block at the same clock time must NOT inherit the classification');
});

// ── Scenario 3 — a genuinely separate meeting remains counted ──────────────
test('scenario 3 — reclassifying the identified block leaves a genuinely separate real meeting fully counted', async () => {
  const DATE = '2026-08-12';
  const sabbathBlock = { start: '9:00 AM', end: '5:00 PM', date: DATE, id: calendarBlockId({ source: 'work_busy', date: DATE, start: '9:00 AM', end: '5:00 PM' }) }; // 8h
  const realMeeting = { start: '5:30 PM', end: '6:30 PM', date: DATE, id: calendarBlockId({ source: 'work_busy', date: DATE, start: '5:30 PM', end: '6:30 PM' }) }; // 1h
  const workBusy = [sabbathBlock, realMeeting];

  const before = computeCalendarLoad({ workBusy, calendar: [] });
  assert.equal(before.meetingHours, 9, 'sanity: 8h + 1h = 9h before any classification');

  const questionId = await seedInstance({
    subjectLocalDate: DATE, subjectBlockIds: [sabbathBlock.id],
  });

  mockCompileClassification({
    objectValue: 'a Sabbath observance, not meetings',
    evidenceSpan: `${TEST_MARKER} it's a Sabbath block, not actual meetings`,
  });
  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: `${TEST_MARKER} q`, answer: `${TEST_MARKER} it's a Sabbath block, not actual meetings`,
    signalKey: 'brief_open_question', questionId,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const resolved = await resolveContext({ tz: TZ });
  const overrides = matchCalendarClassifications(resolved, { calendar: [], workBusy, targetLocalDate: DATE });
  const after = computeCalendarLoad({ workBusy, calendar: [], classifiedOverrides: overrides });
  assert.equal(after.meetingHours, 1, 'only the classified 8h block drops out — the genuinely separate 1h meeting remains fully counted');
});

// ── Scenario 4 — multiple candidate blocks: never guess, never false-200 ───
test('scenario 4 — multiple comparably-sized candidate blocks cannot cause an arbitrary classification or a false 200', async () => {
  const DATE = '2026-08-13';
  const blockA = { start: '9:00 AM', end: '1:00 PM', date: DATE, id: calendarBlockId({ source: 'work_busy', date: DATE, start: '9:00 AM', end: '1:00 PM' }) };
  const blockB = { start: '2:00 PM', end: '6:00 PM', date: DATE, id: calendarBlockId({ source: 'work_busy', date: DATE, start: '2:00 PM', end: '6:00 PM' }) };

  const questionId = await seedInstance({
    subjectLocalDate: DATE, subjectBlockIds: [blockA.id, blockB.id], subjectAmbiguous: true,
  });

  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: `${TEST_MARKER} q`, answer: `${TEST_MARKER} it's a Sabbath block, not actual meetings`,
    signalKey: 'brief_open_question', questionId,
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'calendar_subject_ambiguous');

  // Nothing was written: no context_assertions, no answered ledger row, and
  // the instance itself is still unanswered — safely retryable, e.g. once a
  // real clarification UI narrows it down.
  const { rows } = await db.query(`SELECT id FROM context_assertions WHERE raw_text LIKE $1`, [`%${TEST_MARKER}%`]);
  assert.equal(rows.length, 0, 'no classification may be persisted for an ambiguous subject');
  const answered = await openQuestionsStore.answeredOn('2026-08-10');
  assert.equal(answered.filter((a) => a.questionText.includes(TEST_MARKER)).length, 0);
  const instance = await openQuestionInstancesStore.getById(questionId);
  assert.equal(instance.answeredAt, null, 'the question must remain open/answerable, not durably (wrongly) suppressed');

  // A retry with the identical payload hits the SAME wall, not a random guess.
  const retry = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: `${TEST_MARKER} q`, answer: `${TEST_MARKER} it's a Sabbath block, not actual meetings`,
    signalKey: 'brief_open_question', questionId,
  });
  assert.equal(retry.status, 409);
});

// ── Scenario 5 — compiler failure leaves the question retryable ────────────
test('scenario 5 — a context-compiler failure on a calendar-load instance answer leaves the question retryable and writes no answered ledger', async () => {
  const DATE = '2026-08-14';
  const block = { start: '9:00 AM', end: '6:00 PM', date: DATE, id: calendarBlockId({ source: 'work_busy', date: DATE, start: '9:00 AM', end: '6:00 PM' }) };
  const questionId = await seedInstance({ subjectLocalDate: DATE, subjectBlockIds: [block.id] });

  mockCompileThrows();
  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: `${TEST_MARKER} q`, answer: `${TEST_MARKER} it's a Sabbath block, not actual meetings`,
    signalKey: 'brief_open_question', questionId,
  });
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.code, 'context_compilation_failed');

  const { rows: annRows } = await db.query(`SELECT id FROM annotations WHERE label LIKE $1`, [`%${TEST_MARKER}%`]);
  assert.equal(annRows.length, 0, 'nothing (not even the raw annotation) should be persisted for a failed identity-bearing write');
  const instance = await openQuestionInstancesStore.getById(questionId);
  assert.equal(instance.answeredAt, null, 'a compiler failure must not durably mark the question answered');
  const answered = await openQuestionsStore.answeredOn('2026-08-10');
  assert.equal(answered.filter((a) => a.questionText.includes(TEST_MARKER)).length, 0, 'no answered-ledger row for a failed write');
});

// ── Idempotency: an already-answered instance is a safe no-op, not a re-classify ──
test('an already-answered instance short-circuits idempotently rather than re-processing', async () => {
  const DATE = '2026-08-15';
  const block = { start: '9:00 AM', end: '6:00 PM', date: DATE, id: calendarBlockId({ source: 'work_busy', date: DATE, start: '9:00 AM', end: '6:00 PM' }) };
  const questionId = await seedInstance({ subjectLocalDate: DATE, subjectBlockIds: [block.id] });
  await openQuestionInstancesStore.markAnswered(questionId);

  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({
    question: `${TEST_MARKER} q`, answer: `${TEST_MARKER} it's a Sabbath block, not actual meetings`,
    signalKey: 'brief_open_question', questionId,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.alreadyAnswered, true);
  const { rows } = await db.query(`SELECT id FROM annotations WHERE label LIKE $1`, [`%${TEST_MARKER}%`]);
  assert.equal(rows.length, 0, 'an idempotent replay must not create a second annotation/classification');
});
