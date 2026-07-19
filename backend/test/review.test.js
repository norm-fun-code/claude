const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/llm');
const { composeReview, reviewAttempt } = require('../src/intelligence/review');

test('composeReview builds a JSON-shaped weekly-review prompt from context', () => {
  const ctx = {
    periodStart: new Date('2026-05-23T00:00:00Z'),
    periodEnd: new Date('2026-05-30T00:00:00Z'),
    metrics: [
      { label: 'Sleep', thisWeek: 6.8, lastWeek: 7.4, change: -0.08, goodWhen: 'up', isTotal: false },
      { label: 'Spending', thisWeek: 6698, lastWeek: 5000, change: 0.34, goodWhen: null, isTotal: true },
    ],
    correlations: [{ title: 'Sleep ↔ Focus: strong positive correlation [confirmed]' }],
    forecasts: [{ title: 'Hit $260k: 0% likely' }],
    leverage: [{ title: 'Protect more sleep' }],
    // Canonical weekly event ledger shape (intelligence/weeklyLedger.js) —
    // composeReview renders from ctx.weeklyLedger.episodes, not raw
    // annotation rows (see the two-nights-reported-as-one bug fix).
    weeklyLedger: { episodes: [{ nightOf: '2026-05-24', concepts: ['travel'], assertionIds: ['annotation:1'], labels: ['NYC trip'] }] },
  };
  const { system, prompt } = composeReview(ctx);

  assert.match(system, /weekly review/i);
  assert.match(prompt, /Week of 2026-05-23 to 2026-05-30/);
  assert.match(prompt, /Sleep: 6.8 \(weekly avg\) \(-8% vs last week\)/);
  // Flow metrics are labeled as weekly totals (the Wealth/Insights fix).
  assert.match(prompt, /Spending: 6698 \(weekly total\)/);
  assert.match(prompt, /Sleep ↔ Focus/);
  assert.match(prompt, /Protect more sleep/);
  assert.match(prompt, /night of Sunday, May 24: travel/);
  assert.match(prompt, /"headline"/); // asks for the JSON shape
});

test('composeReview tolerates an empty week', () => {
  const { prompt } = composeReview({
    periodStart: new Date('2026-05-23T00:00:00Z'),
    periodEnd: new Date('2026-05-30T00:00:00Z'),
    metrics: [], correlations: [], forecasts: [], leverage: [], weeklyLedger: { episodes: [] }, intentions: [],
  });
  assert.match(prompt, /not enough data/i);
  assert.match(prompt, /none identified this week/i);
  assert.match(prompt, /none set/i); // intentions section present even when empty
});

// Bug bash: runReview() used to make a single-shot LLM call with no jsonMode/
// schema, no retry, and its validator silently dropped domainReads/crossDomain
// even on success. Live production data showed the fallback sentinel
// ('headline: "Weekly review"', suppressed from the mobile app entirely)
// landing on roughly half of real scheduled runs. reviewAttempt() is the
// extracted, directly-testable single-attempt unit — runReview() calls it
// up to twice.
test('reviewAttempt requests structured JSON output (jsonMode + schema)', async () => {
  let seenOpts = null;
  llm.generateText = async (opts) => { seenOpts = opts; return JSON.stringify({ headline: 'H', narrative: 'N', wins: [], watchouts: [], focus: [] }); };
  await reviewAttempt('sys', 'prompt', 'test');
  assert.equal(seenOpts.jsonMode, true);
  assert.ok(seenOpts.jsonSchema, 'must pass a schema so providers that support it constrain generation server-side');
});

test('reviewAttempt returns null content (retryable) on unparseable output instead of throwing', async () => {
  llm.generateText = async () => 'not json at all';
  const { content } = await reviewAttempt('sys', 'prompt', 'test');
  assert.equal(content, null);
});

test('reviewAttempt returns null content (retryable) when the model call itself throws, with empty rawText', async () => {
  llm.generateText = async () => { throw new Error('rate limited'); };
  const { content, rawText } = await reviewAttempt('sys', 'prompt', 'test');
  assert.equal(content, null);
  assert.equal(rawText, '');
});

test('reviewAttempt returns null content when headline/narrative are missing (matches evening-brief.js\'s shape-check pattern), but still surfaces rawText', async () => {
  llm.generateText = async () => JSON.stringify({ wins: [], watchouts: [], focus: [] });
  const { content, rawText } = await reviewAttempt('sys', 'prompt', 'test');
  assert.equal(content, null);
  assert.match(rawText, /wins/); // the caller's final fallback surfaces this as the narrative
});

test('reviewAttempt propagates domainReads and crossDomain on success (previously silently dropped)', async () => {
  llm.generateText = async () => JSON.stringify({
    headline: 'A good week',
    narrative: 'Long story.',
    domainReads: { health: 'Slept well.', wealth: 'Spent less.', focus: 'Sharp.' },
    crossDomain: 'Better sleep tracked with lower spend.',
    wins: ['Win 1'], watchouts: ['Watch 1'], focus: ['Focus 1'],
  });
  const { content } = await reviewAttempt('sys', 'prompt', 'test');
  assert.deepEqual(content.domainReads, { health: 'Slept well.', wealth: 'Spent less.', focus: 'Sharp.' });
  assert.equal(content.crossDomain, 'Better sleep tracked with lower spend.');
  assert.deepEqual(content.wins, ['Win 1']);
});

test('reviewAttempt defaults crossDomain to empty string and omits domainReads when absent (backward-compatible)', async () => {
  llm.generateText = async () => JSON.stringify({ headline: 'H', narrative: 'N', wins: [], watchouts: [], focus: [] });
  const { content } = await reviewAttempt('sys', 'prompt', 'test');
  assert.equal(content.crossDomain, '');
  assert.equal(content.domainReads, undefined);
});
