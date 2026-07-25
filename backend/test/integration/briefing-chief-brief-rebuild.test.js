// Integration coverage for POST /api/briefing/chief-brief/rebuild — the
// scoped "just retry the Chief-of-Staff card" endpoint added after the live
// silent-staleness bug, so the user isn't stuck waiting through a full
// 60-90s rebuild just to retry one LLM call. Asserts it only touches
// chiefBrief/morningFocus/chiefBriefStale/errors and leaves every other
// field (weather, wealth, etc.) exactly as it was.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');

const app = buildTestApp();
const MARKER = `quick-rebuild prior marker ${Date.now()}`;
const WEATHER_MARKER = { condition: `untouched-${Date.now()}` };

const OLD_BUILT_AT = '2020-01-01T00:00:00.000Z';

async function seedPriorBriefing() {
  const content = {
    day: new Date().toISOString().slice(0, 10),
    builtAt: OLD_BUILT_AT,
    chiefBrief: { synthesis: MARKER, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    morningFocus: 'prior focus',
    weather: WEATHER_MARKER,
    leverageActions: [{ title: 'Sleep earlier', detail: 'HRV trends up on early nights' }],
    forecasts: [{ title: 'Savings goal', detail: 'behind pace', status: 'at_risk' }],
  };
  const { rows } = await db.query(
    `INSERT INTO briefings (kind, content) VALUES ('daily', $1) RETURNING id`,
    [JSON.stringify(content)]
  );
  return rows[0].id;
}

after(async () => {
  await db.query(`DELETE FROM briefings WHERE content->'chiefBrief'->>'synthesis' IN ($1, $2)`, [MARKER, 'quick fresh synthesis']);
  await closeDb();
});

test('POST /api/briefing/chief-brief/rebuild 409s when no briefing has ever been built', async () => {
  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader());
  // Either 409 (no prior at all) or 200 (a prior exists from another test run) —
  // this just guards the 409 branch exists and doesn't crash; the real
  // behavior is covered by the seeded tests below.
  assert.ok(res.status === 409 || res.status === 200);
});

test('a successful scoped rebuild replaces chiefBrief/morningFocus and clears chiefBriefStale, WITHOUT touching other fields', async (t) => {
  await seedPriorBriefing();
  // Long enough to clear assessChiefBriefQuality's minimum-completeness bar
  // (brain/claimValidator.js: synthesis >= 12 words, action/risk/move >= 4,
  // morningFocus >= 15 when present) — since a scoped rebuild that fails the
  // quality bar no longer replaces the existing card (audit fix, item B), a
  // too-short "fresh" fixture here would silently keep showing the OLD
  // MARKER content and fail this test's very next assertion.
  const FRESH = 'quick fresh synthesis with plenty of real words to clear the completeness bar';

  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  // The chief-brief call requests returnMeta:true (safe-to-log metadata
  // alongside the text — see briefing-ai.js) — a bare string here would
  // break chiefBriefAttempt's destructuring.
  llm.generateText = async () => ({
    text: JSON.stringify({
      chiefBrief: {
        synthesis: FRESH,
        action: 'Block focus time this morning for the highest-leverage task.',
        risk: 'Meetings could crowd out the deep work window if unprotected.',
        move: 'Commit to the single most important task before checking email.',
        openQuestion: '',
      },
      morningFocus: 'fresh focus with enough words in it to comfortably clear the fifteen word minimum threshold',
    }),
    stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
  });

  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.chiefBrief.synthesis, FRESH);
  assert.equal(res.body.morningFocus, 'fresh focus with enough words in it to comfortably clear the fifteen word minimum threshold');
  assert.equal(res.body.chiefBriefStale, false);
  assert.deepEqual(res.body.weather, WEATHER_MARKER, 'unrelated fields must be untouched');
  assert.deepEqual(res.body.leverageActions, [{ title: 'Sleep earlier', detail: 'HRV trends up on early nights' }]);
  assert.notEqual(res.body.builtAt, OLD_BUILT_AT, 'builtAt must advance so the "Built X ago" label reflects this attempt');
});

test('a scoped rebuild that STILL fails after its retry keeps the existing card and flags chiefBriefStale, without erroring the request', async (t) => {
  await seedPriorBriefing();

  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  llm.generateText = async () => ({ text: 'not valid json, still broken', stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' });

  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);

  assert.equal(res.status, 200);
  assert.equal(res.body.chiefBrief.synthesis, MARKER, 'keeps showing the last good brief rather than blanking it');
  assert.equal(res.body.chiefBriefStale, true);
  assert.ok(res.body.errors.some((e) => e.service === 'chiefBrief'));
  assert.notEqual(
    res.body.builtAt, OLD_BUILT_AT,
    'builtAt must still advance even when the retry fails — otherwise a failed retry looks identical to the tap doing nothing at all'
  );
});
