// review.js's runReview() previously trusted ANY successfully-parsed JSON
// object with no shape check at all (the review flagged this as the weakest
// validation of all ~10 LLM-parse call sites) — a parsed-but-malformed
// response (missing headline, wins/watchouts/focus as the wrong type) would
// reach the client as-is. Now goes through src/llm/parseJson.js like every
// other site. Runs against a real (likely empty) DB — gatherWeek tolerates
// that fine (see review.test.js's "tolerates an empty week").
const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../../src/llm');
const db = require('../../src/db');

test.after(async () => { await db.pool.end(); });

test('runReview accepts a well-formed response and coerces missing arrays', async (t) => {
  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  llm.generateText = async () => JSON.stringify({ headline: 'Solid week', narrative: 'Things went well.' /* wins/watchouts/focus omitted */ });

  const { runReview } = require('../../src/intelligence/review');
  const result = await runReview({ persist: false });

  assert.equal(result.headline, 'Solid week');
  assert.equal(result.narrative, 'Things went well.');
  assert.deepEqual(result.wins, []);
  assert.deepEqual(result.watchouts, []);
  assert.deepEqual(result.focus, []);
});

test('runReview falls back to a safe default (raw text as narrative) when headline is missing', async (t) => {
  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  llm.generateText = async () => JSON.stringify({ narrative: 'No headline here.' });

  const { runReview } = require('../../src/intelligence/review');
  const result = await runReview({ persist: false });

  assert.equal(result.headline, 'Weekly review');
  assert.ok(result.narrative.includes('narrative'), 'falls back to showing the raw model text, not silently dropping it');
});

test('runReview falls back safely when the response is not valid JSON at all', async (t) => {
  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  llm.generateText = async () => 'Sorry, I cannot help with that right now.';

  const { runReview } = require('../../src/intelligence/review');
  const result = await runReview({ persist: false });

  assert.equal(result.headline, 'Weekly review');
  assert.equal(result.narrative, 'Sorry, I cannot help with that right now.');
});
