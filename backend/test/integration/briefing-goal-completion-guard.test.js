// Bug: the chief brief said "Valuation presentation to Steffan is done" while
// its weekly_intentions.goals[].achieved checkbox was still false. This
// exercises the REAL POST /briefing/chief-brief/rebuild route end-to-end
// (real DB-backed weekly_intentions, real briefing.js wiring) with only the
// LLM stubbed, to prove the scoped rebuild enforces the exact same
// goal-completion invariant as the full builder — not a separate, weaker copy.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const briefingsStore = require('../../src/store/briefings');
const intentionsStore = require('../../src/store/intentions');
const llm = require('../../src/llm');

const app = buildTestApp();
const ORIG_GENERATE_TEXT = llm.generateText;

function chiefJson(overrides = {}) {
  return JSON.stringify({
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm', openQuestion: '', ...overrides },
    morningFocus: overrides.morningFocus ?? 'mf',
    urgentEmails: [],
  });
}

async function seedPriorDailyBriefing() {
  await briefingsStore.saveBriefing({
    kind: 'daily',
    content: { chiefBrief: { synthesis: 'prior', action: 'a', risk: 'r', move: 'm' }, morningFocus: 'prior mf' },
  });
}

afterEach(async () => {
  llm.generateText = ORIG_GENERATE_TEXT;
  await db.query(`DELETE FROM weekly_intentions WHERE week_start = $1`, [intentionsStore.weekStart()]);
  await db.query(`DELETE FROM briefings WHERE kind = 'daily'`);
});
after(async () => { await closeDb(); });

test('POST /briefing/chief-brief/rebuild rejects a claim that an OPEN goal is done', async () => {
  await intentionsStore.saveIntention({ goals: [{ text: 'Valuation presentation to Steffan', achieved: false }] });
  await seedPriorDailyBriefing();
  llm.generateText = async () => chiefJson({ synthesis: 'Valuation presentation to Steffan is done.' });

  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).send({});
  assert.equal(res.status, 200);
  assert.ok(res.body.chiefBrief, 'a usable chiefBrief must ship');
  assert.doesNotMatch(res.body.chiefBrief.synthesis, /is done/i);
});

test('POST /briefing/chief-brief/rebuild allows completion language for a goal marked achieved', async () => {
  await intentionsStore.saveIntention({ goals: [{ text: 'Finish the Q3 board deck', achieved: true }] });
  await seedPriorDailyBriefing();
  llm.generateText = async () => chiefJson({ synthesis: 'The Q3 board deck is done — nice work.' });

  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).send({});
  assert.equal(res.status, 200);
  assert.match(res.body.chiefBrief.synthesis, /Q3 board deck is done/);
});
