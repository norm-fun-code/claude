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

// The chief-brief call requests returnMeta:true (safe-to-log metadata
// alongside the text — see briefing-ai.js), so the stub must return
// {text, stopReason, requestId, model}, not a bare string.
function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
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
  llm.generateText = async () => chiefMeta(chiefJson({ synthesis: 'Valuation presentation to Steffan is done.' }));

  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).send({});
  assert.equal(res.status, 200);
  assert.ok(res.body.chiefBrief, 'a usable chiefBrief must ship');
  assert.doesNotMatch(res.body.chiefBrief.synthesis, /is done/i);
});

test('POST /briefing/chief-brief/rebuild allows completion language for a goal marked achieved', async () => {
  await intentionsStore.saveIntention({ goals: [{ text: 'Finish the Q3 board deck', achieved: true }] });
  await seedPriorDailyBriefing();
  // Every field must clear assessChiefBriefQuality's minimum-completeness bar
  // (synthesis >= 12 words, action/risk/move >= 4, morningFocus >= 15 when
  // present) — since a scoped rebuild that fails the quality bar no longer
  // replaces the existing card (audit fix, item B), the bare chiefJson()
  // placeholders (single-letter action/risk/move, 2-word morningFocus) would
  // silently keep showing the seeded prior's synthesis and fail the
  // assertion below.
  llm.generateText = async () => chiefMeta(chiefJson({
    synthesis: 'The Q3 board deck is done — nice work wrapping up that project ahead of schedule.',
    action: 'Block time this afternoon to prep for the next board meeting.',
    risk: 'Momentum could stall if follow-up items are not assigned owners.',
    move: 'Send a wrap-up note thanking the team for finishing the deck.',
    morningFocus: 'Nice work finishing that board deck well ahead of schedule with plenty of time to spare today',
  }));

  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.chiefBrief.synthesis, /Q3 board deck is done/);
});
