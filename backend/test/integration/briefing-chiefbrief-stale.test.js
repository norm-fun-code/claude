// Integration coverage for the bug reported live: rebuilding the briefing
// left the Chief-of-Staff card showing yesterday's brief with zero visible
// error anywhere, while every other card refreshed. Root cause: briefing.js
// falls back to the prior build's chiefBrief whenever the fresh LLM call
// returns an invalid shape (intentional — a single bad rebuild shouldn't
// blank the card) — but that fallback was completely silent. This test
// reproduces the exact failure mode against a real DB and asserts the fix:
// the fallback is now recorded in `errors` and flagged via chiefBriefStale
// so it's diagnosable and visible to the client instead of masquerading as
// a successful refresh.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');

const app = buildTestApp();
const MARKER = `prior chief brief synthesis marker ${Date.now()}`;

async function seedPriorBriefing() {
  const content = {
    day: new Date().toISOString().slice(0, 10),
    chiefBrief: { synthesis: MARKER, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    morningFocus: 'prior focus',
    urgentEmails: [],
  };
  const { rows } = await db.query(
    `INSERT INTO briefings (kind, content) VALUES ('daily', $1) RETURNING id`,
    [JSON.stringify(content)]
  );
  return rows[0].id;
}

after(async () => {
  await db.query(`DELETE FROM briefings WHERE content->'chiefBrief'->>'synthesis' = $1`, [MARKER]);
  await closeDb();
});

test('a rebuild whose LLM call returns an invalid chiefBrief shape falls back to the prior brief AND flags it (chiefBriefStale + errors), instead of silently looking fresh', async (t) => {
  await seedPriorBriefing();

  // Force generateChiefBrief's strict shape check to fail (missing "move") —
  // this is exactly the silent-failure path the live bug went through.
  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) {
      return JSON.stringify({ chiefBrief: { synthesis: 'fresh but incomplete', action: 'a', risk: 'r' /* move missing */ }, morningFocus: 'fresh focus' });
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);

  assert.equal(res.status, 200);
  assert.equal(res.body.chiefBrief?.synthesis, MARKER, 'the prior brief is shown, not a blank/broken one');
  assert.equal(res.body.chiefBriefStale, true, 'the response says this card is NOT fresh');
  assert.ok(
    Array.isArray(res.body.errors) && res.body.errors.some((e) => e.service === 'chiefBrief'),
    `expected an errors[] entry naming chiefBrief; got: ${JSON.stringify(res.body.errors)}`
  );
});

test('a rebuild whose LLM call returns a valid chiefBrief shape is NOT flagged stale', async (t) => {
  await seedPriorBriefing();
  const FRESH_MARKER = `fresh synthesis ${Date.now()}`;

  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) {
      return JSON.stringify({
        chiefBrief: { synthesis: FRESH_MARKER, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
        morningFocus: 'fresh focus',
      });
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);

  assert.equal(res.status, 200);
  assert.equal(res.body.chiefBrief?.synthesis, FRESH_MARKER);
  assert.equal(res.body.chiefBriefStale, false);

  await db.query(`DELETE FROM briefings WHERE content->'chiefBrief'->>'synthesis' = $1`, [FRESH_MARKER]);
});

test('GET /api/briefing without ?refresh serves the cache instantly (cached:true) rather than rebuilding', async () => {
  await seedPriorBriefing();
  const res = await request(app).get('/api/briefing').set(authHeader()).timeout(15000);
  assert.equal(res.status, 200);
  assert.equal(res.body.cached, true);
});
