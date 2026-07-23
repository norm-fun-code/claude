// Bug history, in order:
//   1. The chief-brief call forced a tool call (jsonMode+jsonSchema) for
//      guaranteed JSON shape. Anthropic's API refuses to combine forced
//      tool_choice with extended thinking, so the single most
//      reasoning-dependent call in the app silently ran with thinking OFF.
//   2. Fixed by dropping the forced tool in favor of a free-form prose
//      instruction + a repair-oriented JSON extractor. That restored
//      thinking but reintroduced the exact class of bug forced-tool existed
//      to prevent: an unconstrained response "rescued" by fence-stripping/
//      brace-slicing/control-char patching instead of actually guaranteed.
//   3. Corrected with native Structured Outputs (output_config.format) —
//      guaranteed shape AND thinking stays on. No forced tool, no
//      tool_choice, no prefill, direct JSON.parse (no prose repair).
//   4. Production-hardening audit follow-up (this file): the parse-failure
//      log used to include a 500-char preview of the actual response —
//      chief briefs carry health/finance/email/goal content, so that's a
//      sensitive-data leak into logs. Retries were also one-size-fits-all
//      (identical retry regardless of WHY the first attempt failed), which
//      is wrong for a refusal (retrying the identical request is pointless
//      and risks generating/reusing unvalidated content) and wrong for a
//      max_tokens truncation (retrying with the SAME token limit just
//      truncates again). And the call relied on whichever LLM_PROVIDER was
//      globally configured, even though CHIEF_MODEL is always an Anthropic
//      model ID and Structured Outputs/adaptive thinking are
//      Anthropic-specific.
//
// This file's coverage, matching that history: request shape (model,
// Structured Outputs, effort, provider pin), safe-metadata-only logging,
// the error-specific retry policy (exact attempt counts + token limits per
// failure type), the LLM_PROVIDER-independent provider pin, and startup
// validation of ANTHROPIC_CHIEF_EFFORT.
const test = require('node:test');
const assert = require('node:assert/strict');

// Field text is deliberately long enough to clear assessChiefBriefQuality's
// minimum-completeness bar (brain/claimValidator.js) — a too-short "valid"
// fixture would otherwise silently trigger the one bounded quality retry and
// throw off every exact-call-count assertion in this file.
const CHIEF_JSON = JSON.stringify({
  chiefBrief: {
    synthesis: 'Test synthesis with enough words in it to clear the quality bar for a complete brief.',
    action: 'Test action with enough words here to clear the bar.',
    risk: 'Test risk with enough words here to clear the bar.',
    move: 'Test move with enough words here to clear the bar.',
    openQuestion: '',
    affirmation: 'Test affirmation with enough words here to clear the bar.',
  },
  morningFocus: 'Test morning focus with enough words in it to comfortably clear the fifteen word minimum threshold for this field.',
  urgentEmails: [],
});

function metaResult(text, overrides = {}) {
  return { text, stopReason: 'end_turn', requestId: 'msg_test', model: 'claude-sonnet-5', ...overrides };
}

function resetModules() {
  delete require.cache[require.resolve('../src/services/briefing-ai')];
  delete require.cache[require.resolve('../src/llm')];
  delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  delete require.cache[require.resolve('../src/llm/providers/gemini')];
}

test('generateChiefBrief asks llm.generateText for Sonnet 5 with adaptive thinking + native Structured Outputs, pinned to the anthropic provider, NOT forced-tool jsonMode/jsonSchema, no temperature', async () => {
  const llm = require('../src/llm');
  const original = llm.generateText;
  let captured = null;
  llm.generateText = async (opts) => { captured = opts; return metaResult(CHIEF_JSON); };
  try {
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.ok(captured, 'llm.generateText was called');
    assert.equal(captured.model, 'claude-sonnet-5');
    assert.equal(captured.provider, 'anthropic', 'must pin to the anthropic provider explicitly');
    assert.equal(captured.returnMeta, true, 'must request safe metadata (model/stopReason/requestId) alongside the text');
    assert.equal(captured.jsonMode, undefined, 'forced-tool jsonMode must not be requested — it disables extended thinking');
    assert.equal(captured.jsonSchema, undefined);
    assert.equal(captured.temperature, undefined, 'the Anthropic provider never forwards temperature — Opus 4.6+/Sonnet 5 reject non-default sampling params');
    assert.ok(captured.outputSchema && typeof captured.outputSchema === 'object', 'outputSchema (Structured Outputs) must be requested');
    assert.equal(captured.outputSchema.additionalProperties, false);
    assert.ok(captured.outputSchema.properties.chiefBrief, 'schema covers chiefBrief');
    assert.ok(captured.outputSchema.properties.urgentEmails, 'schema covers urgentEmails');
    assert.equal(captured.effort, 'medium', 'defaults to medium effort');
    assert.equal(captured.maxTokens, 16384, 'medium effort gets the base 16384 initial ceiling');
  } finally {
    llm.generateText = original;
  }
});

test('ANTHROPIC_CHIEF_MODEL env override is respected without touching the shared ANTHROPIC_MODEL default', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_CHIEF_MODEL = 'claude-opus-4-8';
  try {
    resetModules();
    const llm = require('../src/llm');
    let captured = null;
    const original = llm.generateText;
    llm.generateText = async (opts) => { captured = opts; return metaResult(CHIEF_JSON); };
    try {
      const { generateChiefBrief } = require('../src/services/briefing-ai');
      await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
      assert.equal(captured.model, 'claude-opus-4-8');
    } finally {
      llm.generateText = original;
    }
  } finally {
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('ANTHROPIC_CHIEF_EFFORT env override is respected independently of the model', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_CHIEF_EFFORT = 'high';
  try {
    resetModules();
    const llm = require('../src/llm');
    let captured = null;
    const original = llm.generateText;
    llm.generateText = async (opts) => { captured = opts; return metaResult(CHIEF_JSON); };
    try {
      const { generateChiefBrief } = require('../src/services/briefing-ai');
      await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
      assert.equal(captured.effort, 'high');
      assert.equal(captured.model, 'claude-sonnet-5', 'model default untouched by the effort override');
    } finally {
      llm.generateText = original;
    }
  } finally {
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('xhigh/max effort uses at least 65536 initial maxTokens; low/medium/high use the smaller base', async () => {
  const ORIGINAL_ENV = { ...process.env };
  try {
    for (const [effort, expected] of [['low', 16384], ['medium', 16384], ['high', 16384], ['xhigh', 65536], ['max', 65536]]) {
      process.env.ANTHROPIC_CHIEF_EFFORT = effort;
      resetModules();
      const llm = require('../src/llm');
      let captured = null;
      const original = llm.generateText;
      llm.generateText = async (opts) => { captured = opts; return metaResult(CHIEF_JSON); };
      try {
        const { generateChiefBrief } = require('../src/services/briefing-ai');
        await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
        assert.equal(captured.maxTokens, expected, `effort=${effort} should request maxTokens=${expected}`);
      } finally {
        llm.generateText = original;
      }
    }
  } finally {
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('an invalid ANTHROPIC_CHIEF_EFFORT fails loudly at require time, not with a paid 400 request', () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_CHIEF_EFFORT = 'ultra-max-plus';
  try {
    resetModules();
    assert.throws(
      () => require('../src/services/briefing-ai'),
      /Invalid ANTHROPIC_CHIEF_EFFORT/
    );
  } finally {
    process.env = ORIGINAL_ENV;
    resetModules();
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
    return { data: { id: 'msg_e2e', content: [{ type: 'text', text: CHIEF_JSON }], stop_reason: 'end_turn', usage: {} } };
  };
  try {
    resetModules();
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);

    // Produces schema-valid JSON: the real round trip parsed cleanly into the
    // validated internal brief shape.
    assert.ok(result.chiefBrief, 'the real-provider round trip produced a valid parsed brief');
    assert.equal(result.chiefBrief.synthesis, 'Test synthesis with enough words in it to clear the quality bar for a complete brief.');
    assert.equal(result.morningFocus, 'Test morning focus with enough words in it to comfortably clear the fifteen word minimum threshold for this field.');
    assert.deepEqual(result.urgentEmails, []);

    assert.equal(capturedBody.model, 'claude-sonnet-5');
    assert.deepEqual(capturedBody.thinking, { type: 'adaptive' }, 'extended thinking must actually be requested');
    assert.equal(capturedBody.tools, undefined, 'no forced tool call');
    assert.equal(capturedBody.tool_choice, undefined, 'no forced tool_choice');
    assert.ok(capturedBody.output_config, 'output_config must be present');
    assert.equal(capturedBody.output_config.effort, 'medium');
    assert.equal(capturedBody.output_config.format.type, 'json_schema');
    assert.ok(capturedBody.output_config.format.schema.properties.chiefBrief, 'the request schema covers chiefBrief');
    assert.equal(capturedBody.output_config.format.schema.additionalProperties, false);
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('a fresh synthesis that still writes "NN/100" is normalized to the bare number before shipping (headline never shows /100)', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const withSlash = JSON.stringify({
    chiefBrief: {
      synthesis: 'Recovery is green at 90/100 today, and mood, energy, and focus are all running high — a genuine green-light day.',
      action: 'Run the scheduled interval session as planned and focus on hitting your target paces in each rep of the workout.',
      risk: 'Nothing is below its healthy range right now — protect the afternoon focus window so today stays as strong as it started.',
      move: 'Dining spend is running well above your usual weekly pace — worth a glance before it compounds into the monthly budget.',
      openQuestion: '', affirmation: 'I have kept my sleep above seven hours for five days straight, and it is showing up in the numbers.',
    },
    morningFocus: 'Sleep held above seven hours all week and recovery is green at 90/100 — real capacity to spend on the one thing that matters most today.',
    urgentEmails: [],
  });
  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = async () => ({ data: { id: 'msg_slash', content: [{ type: 'text', text: withSlash }], stop_reason: 'end_turn', usage: {} } });
  try {
    resetModules();
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.ok(result.chiefBrief);
    assert.match(result.chiefBrief.synthesis, /green at 90\b/, 'the bare score survives');
    assert.doesNotMatch(result.chiefBrief.synthesis, /\/\s*100/, 'the "/100" fraction is stripped from the headline');
    assert.doesNotMatch(result.morningFocus, /\/\s*100/, 'and from the other prose fields too');
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('LLM_PROVIDER=gemini does not change which provider the chief brief uses — it stays pinned to anthropic', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.LLM_PROVIDER = 'gemini';
  try {
    resetModules();
    const gemini = require('../src/llm/providers/gemini');
    const originalGeminiGenerate = gemini.generateText;
    let geminiCalled = false;
    gemini.generateText = async () => { geminiCalled = true; throw new Error('gemini should never be called for the chief-brief call'); };

    const axios = require('axios');
    const originalPost = axios.post;
    let capturedUrl = null;
    axios.post = async (url, body) => {
      capturedUrl = url;
      return { data: { id: 'msg_gemini_guard', content: [{ type: 'text', text: CHIEF_JSON }], stop_reason: 'end_turn', usage: {} } };
    };

    try {
      const { generateChiefBrief } = require('../src/services/briefing-ai');
      const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
      assert.equal(geminiCalled, false, 'gemini.generateText must never be invoked for the chief-brief call');
      assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages', 'the request must actually hit the Anthropic endpoint');
      assert.ok(result.chiefBrief, 'still produces a valid brief despite LLM_PROVIDER=gemini');
    } finally {
      axios.post = originalPost;
      gemini.generateText = originalGeminiGenerate;
    }
  } finally {
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('a refusal is not retried: exactly one attempt, and the result falls back to empty rather than throwing or mis-parsing', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  let callCount = 0;
  axios.post = async () => {
    callCount++;
    return { data: { id: `msg_refusal_${callCount}`, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, usage: {} } };
  };
  try {
    resetModules();
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.equal(callCount, 1, 'a refusal must not be retried with the identical request');
    assert.equal(result.chiefBrief, null, 'a refused call must not fabricate a brief');
    assert.equal(result.morningFocus, '');
    assert.deepEqual(result.urgentEmails, []);
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('a max_tokens truncation is retried exactly once, with a larger maxTokens on the retry', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  const capturedMaxTokens = [];
  let callCount = 0;
  axios.post = async (url, body) => {
    callCount++;
    capturedMaxTokens.push(body.max_tokens);
    // Truncated on every attempt, so we can see exactly how many were made
    // and exactly what maxTokens each one used.
    return {
      data: {
        id: `msg_trunc_${callCount}`,
        content: [{ type: 'text', text: '{"chiefBrief": {"synthesis": "cut off here' }],
        stop_reason: 'max_tokens',
        usage: {},
      },
    };
  };
  try {
    resetModules();
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.equal(callCount, 2, 'max_tokens gets exactly one retry (two attempts total)');
    assert.deepEqual(capturedMaxTokens, [16384, 32768], 'the retry must use a LARGER maxTokens than the initial attempt (default medium effort: 16384 -> 32768)');
    assert.equal(result.chiefBrief, null, 'still-truncated after the retry falls back to empty, not a fabricated/partial brief');
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('a max_tokens truncation followed by a successful retry stops at two attempts and returns the retry result', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  const capturedMaxTokens = [];
  let callCount = 0;
  axios.post = async (url, body) => {
    callCount++;
    capturedMaxTokens.push(body.max_tokens);
    if (callCount === 1) {
      return { data: { id: 'msg_trunc_1', content: [{ type: 'text', text: 'truncated' }], stop_reason: 'max_tokens', usage: {} } };
    }
    return { data: { id: 'msg_trunc_2', content: [{ type: 'text', text: CHIEF_JSON }], stop_reason: 'end_turn', usage: {} } };
  };
  try {
    resetModules();
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.equal(callCount, 2);
    assert.deepEqual(capturedMaxTokens, [16384, 32768]);
    assert.ok(result.chiefBrief, 'the bumped-token retry succeeded and its result is used');
    assert.equal(result.chiefBrief.synthesis, 'Test synthesis with enough words in it to clear the quality bar for a complete brief.');
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('a transient network failure is retried exactly once with the SAME maxTokens (not bumped)', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  const capturedMaxTokens = [];
  let callCount = 0;
  axios.post = async (url, body) => {
    callCount++;
    capturedMaxTokens.push(body.max_tokens);
    throw new Error('socket hang up');
  };
  try {
    resetModules();
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.equal(callCount, 2, 'a transient failure gets exactly one retry');
    assert.deepEqual(capturedMaxTokens, [16384, 16384], 'a non-max_tokens failure must NOT bump maxTokens on retry');
    assert.equal(result.chiefBrief, null);
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('an internal business-shape validation failure (empty required field) is retried exactly once with the SAME maxTokens', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  const capturedMaxTokens = [];
  let callCount = 0;
  const emptyMoveJson = JSON.stringify({
    chiefBrief: { synthesis: 'x', action: 'y', risk: 'z', move: '', openQuestion: '', affirmation: 'a' },
    morningFocus: 'f',
    urgentEmails: [],
  });
  axios.post = async (url, body) => {
    callCount++;
    capturedMaxTokens.push(body.max_tokens);
    return { data: { id: `msg_shape_${callCount}`, content: [{ type: 'text', text: emptyMoveJson }], stop_reason: 'end_turn', usage: {} } };
  };
  try {
    resetModules();
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.equal(callCount, 2, 'a shape-invalid (schema-valid but business-rule-empty) response gets exactly one retry');
    assert.deepEqual(capturedMaxTokens, [16384, 16384]);
    assert.equal(result.chiefBrief, null);
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('does not enter the old prose-JSON repair loop: a fence-wrapped/prose-prefixed response that extractJson would have rescued is now rejected', async () => {
  // resetModules() FIRST, then require + patch — otherwise the patch lands
  // on a module instance the require cache discards a moment later, and
  // briefing-ai.js ends up with a fresh, unpatched '../llm' (silently
  // falling through to the real provider instead of this stub).
  resetModules();
  const llm = require('../src/llm');
  const original = llm.generateText;
  // This exact shape (code fence + leading prose) is precisely what
  // extractJson's fence-stripping/brace-slicing repair path exists to
  // rescue. Structured Outputs guarantees this can't happen for real, so the
  // chief-brief call intentionally no longer runs that repair — a response
  // in this shape must now be treated as a parse failure, not silently
  // recovered.
  llm.generateText = async () => metaResult(`Here you go:\n\`\`\`json\n${CHIEF_JSON}\n\`\`\``);
  try {
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.equal(result.chiefBrief, null, 'prose-wrapped JSON must NOT be repaired/rescued for the chief-brief call anymore');
  } finally {
    llm.generateText = original;
    resetModules();
  }
});

test('a JSON-parse failure never logs response content — only safe metadata (model, length, stop reason, IDs)', async () => {
  resetModules();
  const llm = require('../src/llm');
  const original = llm.generateText;
  const SENSITIVE_MARKER = 'HRV 41ms, net worth $412,903, therapy note: anxious about layoffs';
  llm.generateText = async () => metaResult(`Not JSON at all — ${SENSITIVE_MARKER}`);

  const originalConsoleError = console.error;
  const loggedLines = [];
  console.error = (...args) => { loggedLines.push(args.map(String).join(' ')); };

  try {
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.equal(result.chiefBrief, null);
    assert.ok(loggedLines.length > 0, 'the failure must be logged (just not with content)');
    for (const line of loggedLines) {
      assert.ok(!line.includes(SENSITIVE_MARKER), `log line leaked response content: ${line}`);
      assert.ok(!line.includes('HRV 41ms'), `log line leaked a content fragment: ${line}`);
      assert.ok(!line.includes('Preview:'), 'the old content-preview log format must be gone entirely');
    }
    // Safe metadata IS expected to be present.
    const combined = loggedLines.join(' | ');
    assert.match(combined, /model=claude-sonnet-5/);
    assert.match(combined, /responseLength=\d+/);
    assert.match(combined, /correlationId=/);
  } finally {
    console.error = originalConsoleError;
    llm.generateText = original;
    resetModules();
  }
});

test('a refusal never logs response content either (empty content, but the guard is exercised end-to-end for good measure)', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = async () => ({
    data: { id: 'msg_refusal_log', content: [], stop_reason: 'refusal', stop_details: { category: 'bio' }, usage: {} },
  });

  const originalConsoleError = console.error;
  const loggedLines = [];
  console.error = (...args) => { loggedLines.push(args.map(String).join(' ')); };

  try {
    resetModules();
    const { generateChiefBrief } = require('../src/services/briefing-ai');
    await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
    assert.ok(loggedLines.some((l) => l.includes('refused')));
    for (const line of loggedLines) assert.ok(!line.includes('Preview:'));
  } finally {
    console.error = originalConsoleError;
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});
