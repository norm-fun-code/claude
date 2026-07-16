// Bug: the chief-brief call — the one call that actually has to REASON across
// body/money/focus/calendar/inbox, not just extract or classify — forced a
// tool call (jsonMode+jsonSchema) for guaranteed JSON shape. Anthropic's API
// refuses to combine forced tool_choice with extended thinking, so the single
// most reasoning-dependent call in the app silently ran with thinking OFF.
//
// Fixed by dropping jsonMode/jsonSchema from chiefBriefAttempt (CHIEF_SYSTEM
// already instructs "Return ONLY a single valid JSON object" in prose, parsed
// via the same parseAndValidate/extractJson path the wisdom call already uses
// successfully) and pinning the model to Opus 4.8 for this call specifically
// — the shared ANTHROPIC_MODEL default (Sonnet 5) still serves every lighter
// call (wisdom, context-adjust, habit parsing, etc.), untouched.
//
// Two layers of coverage: a fast "options contract" test against the
// llm module (proves briefing-ai.js asks for the right thing), and a true
// end-to-end test through the REAL anthropic provider with only axios.post
// stubbed (proves those options actually produce a thinking-enabled request).
const test = require('node:test');
const assert = require('node:assert/strict');

const CHIEF_JSON = JSON.stringify({
  chiefBrief: { synthesis: 'Test synthesis.', action: 'Test action.', risk: 'Test risk.', move: 'Test move.', openQuestion: '', affirmation: 'Test affirmation.' },
  morningFocus: 'Test morning focus.',
  urgentEmails: [],
});

test('generateChiefBrief asks llm.generateText for Opus 4.8 with NO forced-tool jsonMode/jsonSchema', async () => {
  const llm = require('../src/llm');
  const original = llm.generateText;
  let captured = null;
  llm.generateText = async (opts) => { captured = opts; return CHIEF_JSON; };
  try {
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.ok(captured, 'llm.generateText was called');
    assert.equal(captured.model, 'claude-opus-4-8');
    assert.equal(captured.jsonMode, undefined, 'forced-tool jsonMode must not be requested — it disables extended thinking');
    assert.equal(captured.jsonSchema, undefined);
  } finally {
    llm.generateText = original;
  }
});

test('ANTHROPIC_CHIEF_MODEL env override is respected without touching the shared ANTHROPIC_MODEL default', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_CHIEF_MODEL = 'claude-sonnet-5';
  try {
    delete require.cache[require.resolve('../src/services/briefing-ai')];
    const llm = require('../src/llm');
    let captured = null;
    const original = llm.generateText;
    llm.generateText = async (opts) => { captured = opts; return CHIEF_JSON; };
    try {
      const { generateChiefBrief } = require('../src/services/briefing-ai');
      await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
      assert.equal(captured.model, 'claude-sonnet-5');
    } finally {
      llm.generateText = original;
    }
  } finally {
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/services/briefing-ai')];
  }
});

test('end-to-end through the REAL anthropic provider: the chief-brief request body has thinking:adaptive and model claude-opus-4-8', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.ANTHROPIC_CHIEF_MODEL;
  const axios = require('axios');
  const originalPost = axios.post;
  let capturedBody = null;
  axios.post = async (url, body) => {
    capturedBody = body;
    return { data: { content: [{ type: 'text', text: CHIEF_JSON }], usage: {} } };
  };
  try {
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
    delete require.cache[require.resolve('../src/llm')];
    delete require.cache[require.resolve('../src/services/briefing-ai')];
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);

    assert.ok(result.chiefBrief, 'the real-provider round trip still produced a valid parsed brief');
    assert.equal(capturedBody.model, 'claude-opus-4-8');
    assert.deepEqual(capturedBody.thinking, { type: 'adaptive' }, 'extended thinking must actually be requested now');
    assert.equal(capturedBody.tools, undefined, 'no forced tool call');
    assert.equal(capturedBody.tool_choice, undefined);
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
    delete require.cache[require.resolve('../src/llm')];
    delete require.cache[require.resolve('../src/services/briefing-ai')];
  }
});
