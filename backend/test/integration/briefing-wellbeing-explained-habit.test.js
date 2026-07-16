// Live bug found via a product review: the Wisdom card moralized a slipping
// cold-shower streak — "the slipping cold shower habit hints at where
// patience with discomfort is wearing thin" — even though the SAME week's
// day context/annotations already explained it: the user was sick and
// skipped cold showers on doctor's-orders-common-sense grounds, not a
// willpower lapse. wellbeingContext's "lagging habits" detector only ever
// looked at the raw 7-day adherence average — it never checked whether a
// documented reason already existed. It now cross-references recent
// annotations + day-journal notes over the same 7-day window and suppresses
// the "slipping" flag for a habit that's already explained in the user's
// own words.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const llm = require('../../src/llm');
const metricsStore = require('../../src/store/metrics');
const annotationsStore = require('../../src/store/annotations');
const dayJournal = require('../../src/store/dayJournal');

const app = buildTestApp();

function stubCommon({ annotations = [], journal = [] }) {
  metricsStore.dailyAggregate = async ({ domain, metric }) => {
    if (domain === 'habits' && metric === 'cold_shower') {
      // 1 of 7 days done -> ~14% adherence, well under the 60% "lagging" cutoff.
      return [{ day: 'd0', value: 1 }, { day: 'd1', value: 0 }, { day: 'd2', value: 0 }, { day: 'd3', value: 0 }, { day: 'd4', value: 0 }, { day: 'd5', value: 0 }, { day: 'd6', value: 0 }];
    }
    return []; // everything else (wellbeing, other habits, wealth, etc.) — no data, non-fatal
  };
  annotationsStore.overlapping = async () => annotations;
  dayJournal.recent = async () => journal;
}

function captureWisdomPrompt(t) {
  let capturedPrompt = null;
  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  llm.generateText = async ({ system, prompt }) => {
    if (system.includes('chief of staff and data scientist')) {
      // The chief-brief call requests returnMeta:true (safe-to-log metadata
      // alongside the text — see briefing-ai.js) — a bare string here would
      // break chiefBriefAttempt's destructuring.
      return {
        text: JSON.stringify({
          chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm', openQuestion: '', affirmation: '' },
          morningFocus: 'f',
        }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    if (system.includes('reflective "wisdom" section')) {
      capturedPrompt = prompt;
      return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
    }
    return JSON.stringify({});
  };
  return () => capturedPrompt;
}

after(async () => {
  delete metricsStore.dailyAggregate;
  delete annotationsStore.overlapping;
  delete dayJournal.recent;
  await closeDb();
});

test('a lagging habit already explained by a recent annotation is NOT flagged as "slipping"', async (t) => {
  stubCommon({
    annotations: [{ label: 'Sick', note: 'Skipped cold shower this week, fighting off a cold', start_ts: new Date() }],
    journal: [],
  });
  const getPrompt = captureWisdomPrompt(t);

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200);

  const prompt = getPrompt();
  assert.ok(prompt, 'expected the wisdom LLM call to have fired');
  assert.doesNotMatch(prompt, /slipping on[^\\n]*cold shower/, 'an explained dip must not be narrated as "slipping"');
});

test('the SAME lagging habit with no explanation anywhere IS flagged as "slipping" (unchanged behavior)', async (t) => {
  stubCommon({ annotations: [], journal: [] });
  const getPrompt = captureWisdomPrompt(t);

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200);

  const prompt = getPrompt();
  assert.ok(prompt);
  assert.match(prompt, /slipping on[^\n]*cold shower/, 'with no documented reason, the raw statistical flag must still fire');
});

test('an explanation for a DIFFERENT habit does not suppress this one (label-specific matching)', async (t) => {
  stubCommon({
    annotations: [{ label: 'Travel', note: 'Skipped gratitude journaling while traveling', start_ts: new Date() }],
    journal: [],
  });
  const getPrompt = captureWisdomPrompt(t);

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200);

  const prompt = getPrompt();
  assert.ok(prompt);
  assert.match(prompt, /slipping on[^\n]*cold shower/, 'an unrelated habit\'s explanation must not suppress cold shower\'s own flag');
});
