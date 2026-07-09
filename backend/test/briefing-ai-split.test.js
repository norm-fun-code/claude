// The briefing LLM call was split from one combined generateBriefing() call into
// two independent calls (generateChiefBrief + generateWisdomInsights) so they can
// run in parallel and so a same-day rebuild can skip the wisdom call entirely
// (its output is discarded by server.js's day-lock anyway — see briefing-ai.js's
// file header). These tests stub the shared llm module and verify: each function
// parses/validates its own JSON shape correctly, and the combined generateBriefing
// wrapper still merges both into the same shape the old single call returned.
const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/llm');

const CHIEF_JSON = JSON.stringify({
  chiefBrief: { synthesis: 'Test synthesis.', action: 'Test action.', risk: 'Test risk.', move: 'Test move.', openQuestion: '' },
  morningFocus: 'Test morning focus.',
  urgentEmails: [],
});
const WISDOM_JSON = JSON.stringify({
  quoteInsight: 'Test quote insight.',
  notionQuote: 'A complete, self-contained sentence of real wisdom worth reading.',
  notionInsight: 'Test notion insight.',
});

function stubLlm(responses) {
  // responses: array of strings returned in call order (chief first in generateBriefing's
  // Promise.all ordering doesn't matter since we key off the SYSTEM prompt instead).
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) return responses.chief;
    if (system.includes('reflective "wisdom" section')) return responses.wisdom;
    throw new Error('unexpected system prompt in stub');
  };
}

const { generateBriefing, generateChiefBrief, generateWisdomInsights } = require('../src/services/briefing-ai');

test('generateChiefBrief parses a valid response into the expected shape', async () => {
  stubLlm({ chief: CHIEF_JSON, wisdom: WISDOM_JSON });
  const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.equal(result.morningFocus, 'Test morning focus.');
  assert.ok(result.chiefBrief);
  assert.equal(result.chiefBrief.synthesis, 'Test synthesis.');
  assert.deepEqual(result.urgentEmails, []);
});

test('generateWisdomInsights parses a valid response and keeps a legitimate notionQuote', async () => {
  stubLlm({ chief: CHIEF_JSON, wisdom: WISDOM_JSON });
  const result = await generateWisdomInsights('some notion text', 'a quote', 'mood ok');
  assert.equal(result.quoteInsight, 'Test quote insight.');
  assert.equal(result.notionQuote, 'A complete, self-contained sentence of real wisdom worth reading.');
  assert.equal(result.notionInsight, 'Test notion insight.');
});

test('generateWisdomInsights rejects a heading-like notionQuote', async () => {
  stubLlm({
    chief: CHIEF_JSON,
    wisdom: JSON.stringify({ quoteInsight: 'x', notionQuote: '[section: Money]', notionInsight: 'should be dropped too' }),
  });
  const result = await generateWisdomInsights('notion text', 'quote', '');
  assert.equal(result.notionQuote, '');
  assert.equal(result.notionInsight, '', 'insight is dropped along with a rejected quote');
});

test('generateChiefBrief returns null chiefBrief when a required field is missing', async () => {
  stubLlm({
    chief: JSON.stringify({ chiefBrief: { synthesis: 'x', action: 'y', risk: 'z' /* move missing */ }, morningFocus: 'f' }),
    wisdom: WISDOM_JSON,
  });
  const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.equal(result.chiefBrief, null);
});

test('generateChiefBrief retries once and recovers if the second attempt is valid', async () => {
  let call = 0;
  llm.generateText = async ({ system }) => {
    if (!system.includes('chief of staff and data scientist')) return WISDOM_JSON;
    call++;
    // First call: invalid (missing "move"). Second call (the retry): valid.
    return call === 1
      ? JSON.stringify({ chiefBrief: { synthesis: 'x', action: 'y', risk: 'z' }, morningFocus: 'f' })
      : CHIEF_JSON;
  };
  const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.equal(call, 2, 'expected exactly one retry');
  assert.ok(result.chiefBrief, 'the retry succeeded, so chiefBrief should be populated, not null');
  assert.equal(result.chiefBrief.synthesis, 'Test synthesis.');
});

test('generateChiefBrief gives up (null) only after BOTH attempts fail', async () => {
  let call = 0;
  llm.generateText = async ({ system }) => {
    if (!system.includes('chief of staff and data scientist')) return WISDOM_JSON;
    call++;
    return 'not json at all, both times';
  };
  const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.equal(call, 2, 'expected the retry to have been attempted before giving up');
  assert.equal(result.chiefBrief, null);
});

// The caller (briefing.js) silently falls back to the PRIOR build's chiefBrief
// whenever this comes back null — so an invalid shape here used to be
// completely untraceable in production (the exact bug this test guards
// against: a rebuild that silently keeps showing yesterday's brief). This
// must log which field(s) were missing so a recurrence is diagnosable.
test('generateChiefBrief logs which field was invalid so a silent stale-brief fallback is diagnosable', async () => {
  stubLlm({
    chief: JSON.stringify({ chiefBrief: { synthesis: 'x', action: 'y', risk: 'z' /* move missing */ }, morningFocus: 'f' }),
    wisdom: WISDOM_JSON,
  });
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  } finally {
    console.error = originalError;
  }
  assert.ok(
    logs.some((l) => l.includes('shape invalid') && l.includes('move')),
    `expected a log naming the missing field "move"; got: ${JSON.stringify(logs)}`
  );
});

test('generateChiefBrief falls back to empty shape on malformed JSON', async () => {
  llm.generateText = async () => 'not json at all';
  const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.deepEqual(result, { morningFocus: '', chiefBrief: null, urgentEmails: [] });
});

test('generateBriefing (combined, backward-compat) merges both calls into one object', async () => {
  stubLlm({ chief: CHIEF_JSON, wisdom: WISDOM_JSON });
  const result = await generateBriefing([], 'notion text', 'a quote', 'Tuesday', { type: 'Rest' }, []);
  assert.equal(result.morningFocus, 'Test morning focus.');
  assert.ok(result.chiefBrief);
  assert.equal(result.quoteInsight, 'Test quote insight.');
  assert.equal(result.notionQuote, 'A complete, self-contained sentence of real wisdom worth reading.');
});

test('generateBriefing runs chief and wisdom calls concurrently, not serially', async () => {
  const order = [];
  llm.generateText = async ({ system }) => {
    const label = system.includes('chief of staff and data scientist') ? 'chief' : 'wisdom';
    order.push(`${label}:start`);
    await new Promise((r) => setTimeout(r, 20));
    order.push(`${label}:end`);
    return label === 'chief' ? CHIEF_JSON : WISDOM_JSON;
  };
  await generateBriefing([], 'notion text', 'a quote', 'Tuesday', { type: 'Rest' }, []);
  // Both starts happen before either end — proof they overlapped rather than
  // running one to completion before the other began.
  const firstEndIdx = order.findIndex((e) => e.endsWith(':end'));
  const startsBeforeFirstEnd = order.slice(0, firstEndIdx).filter((e) => e.endsWith(':start')).length;
  assert.equal(startsBeforeFirstEnd, 2, 'both calls should have started before either finished');
});
