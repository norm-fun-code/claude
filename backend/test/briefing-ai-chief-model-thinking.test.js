// Bug: the chief-brief call — the one call that actually has to REASON across
// body/money/focus/calendar/inbox, not just extract or classify — forced a
// tool call (jsonMode+jsonSchema) for guaranteed JSON shape. Anthropic's API
// refuses to combine forced tool_choice with extended thinking, so the single
// most reasoning-dependent call in the app silently ran with thinking OFF.
//
// First fix dropped jsonMode/jsonSchema entirely in favor of a free-form
// prose instruction + a repair-oriented JSON extractor (extractJson). That
// restored thinking but reintroduced the exact class of bug forced-tool
// existed to prevent: an unconstrained response that might not even be valid
// JSON, "rescued" by fence-stripping/brace-slicing/control-char patching.
//
// Corrected here: native Structured Outputs (output_config.format) is the
// guaranteed-shape mechanism that composes with extended thinking — no
// forced tool, no tool_choice, no prefill, and (per Anthropic's docs) no
// prose-repair needed because the response is schema-constrained
// server-side. chiefBriefAttempt now parses with a direct JSON.parse and
// treats a parse failure as an API-contract violation worth logging loudly,
// not something to patch. refusal/max_tokens stop reasons are surfaced as
// distinct thrown errors (AnthropicRefusalError/AnthropicMaxTokensError)
// instead of falling through to be mis-parsed as content.
//
// Three layers of coverage: a fast "options contract" test against the llm
// module (proves briefing-ai.js asks for the right thing), a true end-to-end
// test through the REAL anthropic provider with only axios.post stubbed
// (proves those options actually produce a structured-output+thinking
// request and a schema-valid parse), and failure-mode tests (refusal,
// max_tokens, and a would-have-been-repaired prose response) proving the
// call degrades safely instead of throwing or silently accepting garbage.
const test = require('node:test');
const assert = require('node:assert/strict');

const CHIEF_JSON = JSON.stringify({
  chiefBrief: { synthesis: 'Test synthesis.', action: 'Test action.', risk: 'Test risk.', move: 'Test move.', openQuestion: '', affirmation: 'Test affirmation.' },
  morningFocus: 'Test morning focus.',
  urgentEmails: [],
});

test('generateChiefBrief asks llm.generateText for Opus 4.8 with native Structured Outputs, NOT forced-tool jsonMode/jsonSchema', async () => {
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
    assert.ok(captured.outputSchema && typeof captured.outputSchema === 'object', 'outputSchema (Structured Outputs) must be requested');
    assert.equal(captured.outputSchema.additionalProperties, false);
    assert.ok(captured.outputSchema.properties.chiefBrief, 'schema covers chiefBrief');
    assert.ok(captured.outputSchema.properties.urgentEmails, 'schema covers urgentEmails');
    assert.equal(captured.effort, 'high', 'defaults to high effort');
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

test('ANTHROPIC_CHIEF_EFFORT env override is respected independently of the model', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_CHIEF_EFFORT = 'medium';
  try {
    delete require.cache[require.resolve('../src/services/briefing-ai')];
    const llm = require('../src/llm');
    let captured = null;
    const original = llm.generateText;
    llm.generateText = async (opts) => { captured = opts; return CHIEF_JSON; };
    try {
      const { generateChiefBrief } = require('../src/services/briefing-ai');
      await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
      assert.equal(captured.effort, 'medium');
      assert.equal(captured.model, 'claude-opus-4-8', 'model default untouched by the effort override');
    } finally {
      llm.generateText = original;
    }
  } finally {
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/services/briefing-ai')];
  }
});

test('end-to-end through the REAL anthropic provider: the chief-brief request has output_config.format + effort + thinking:adaptive, no forced tool', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.ANTHROPIC_CHIEF_MODEL;
  delete process.env.ANTHROPIC_CHIEF_EFFORT;
  const axios = require('axios');
  const originalPost = axios.post;
  let capturedBody = null;
  axios.post = async (url, body) => {
    capturedBody = body;
    return { data: { content: [{ type: 'text', text: CHIEF_JSON }], stop_reason: 'end_turn', usage: {} } };
  };
  try {
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
    delete require.cache[require.resolve('../src/llm')];
    delete require.cache[require.resolve('../src/services/briefing-ai')];
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);

    // Produces schema-valid JSON: the real round trip parsed cleanly into the
    // validated internal brief shape.
    assert.ok(result.chiefBrief, 'the real-provider round trip produced a valid parsed brief');
    assert.equal(result.chiefBrief.synthesis, 'Test synthesis.');
    assert.equal(result.morningFocus, 'Test morning focus.');
    assert.deepEqual(result.urgentEmails, []);

    assert.equal(capturedBody.model, 'claude-opus-4-8');
    assert.deepEqual(capturedBody.thinking, { type: 'adaptive' }, 'extended thinking must actually be requested');
    assert.equal(capturedBody.tools, undefined, 'no forced tool call');
    assert.equal(capturedBody.tool_choice, undefined, 'no forced tool_choice');
    assert.ok(capturedBody.output_config, 'output_config must be present');
    assert.equal(capturedBody.output_config.effort, 'high');
    assert.equal(capturedBody.output_config.format.type, 'json_schema');
    assert.ok(capturedBody.output_config.format.schema.properties.chiefBrief, 'the request schema covers chiefBrief');
    assert.equal(capturedBody.output_config.format.schema.additionalProperties, false);
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
    delete require.cache[require.resolve('../src/llm')];
    delete require.cache[require.resolve('../src/services/briefing-ai')];
  }
});

test('a refusal stop_reason is handled safely: generateChiefBrief falls back to empty rather than throwing or mis-parsing', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = async () => ({
    data: { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, usage: {} },
  });
  try {
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
    delete require.cache[require.resolve('../src/llm')];
    delete require.cache[require.resolve('../src/services/briefing-ai')];
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.equal(result.chiefBrief, null, 'a refused call must not fabricate a brief');
    assert.equal(result.morningFocus, '');
    assert.deepEqual(result.urgentEmails, []);
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
    delete require.cache[require.resolve('../src/llm')];
    delete require.cache[require.resolve('../src/services/briefing-ai')];
  }
});

test('a max_tokens stop_reason is handled safely: generateChiefBrief falls back to empty rather than parsing truncated JSON', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = async () => ({
    data: {
      // Deliberately truncated mid-object — if this were fed to a lenient
      // parser it might "succeed" on a garbage partial shape.
      content: [{ type: 'text', text: '{"chiefBrief": {"synthesis": "Cut off here' }],
      stop_reason: 'max_tokens',
      usage: {},
    },
  });
  try {
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
    delete require.cache[require.resolve('../src/llm')];
    delete require.cache[require.resolve('../src/services/briefing-ai')];
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.equal(result.chiefBrief, null, 'a truncated call must not fabricate a brief from partial content');
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
    delete require.cache[require.resolve('../src/llm')];
    delete require.cache[require.resolve('../src/services/briefing-ai')];
  }
});

test('does not enter the old prose-JSON repair loop: a fence-wrapped/prose-prefixed response that extractJson would have rescued is now rejected', async () => {
  const llm = require('../src/llm');
  const original = llm.generateText;
  // This exact shape (code fence + leading prose) is precisely what
  // extractJson's fence-stripping/brace-slicing repair path exists to
  // rescue. Structured Outputs guarantees this can't happen for real, so the
  // chief-brief call intentionally no longer runs that repair — a response
  // in this shape must now be treated as a parse failure, not silently
  // recovered.
  llm.generateText = async () => `Here you go:\n\`\`\`json\n${CHIEF_JSON}\n\`\`\``;
  try {
    delete require.cache[require.resolve('../src/services/briefing-ai')];
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.equal(result.chiefBrief, null, 'prose-wrapped JSON must NOT be repaired/rescued for the chief-brief call anymore');
  } finally {
    llm.generateText = original;
    delete require.cache[require.resolve('../src/services/briefing-ai')];
  }
});
