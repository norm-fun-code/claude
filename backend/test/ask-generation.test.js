// Ask NormOS 500 bug, root cause and fix:
//   Ask's reasoning call (chat/ask.js) ran with NO model/effort override and
//   only maxTokens:1600. Sonnet 5's adaptive thinking SHARES max_tokens with
//   the visible answer, so a real reasoning question — e.g. "How would you
//   rate my overall heart health for my age (33yo male)? What does it mean
//   for longevity?" — could exhaust the whole budget on thinking alone,
//   leaving zero tokens for the answer: stop_reason 'max_tokens' with an
//   empty text block, thrown as AnthropicMaxTokensError, uncaught all the
//   way through asyncHandler to a bare 500 (confirmed via a faithful
//   reproduction against the real, unmodified ask() before this fix).
//
// Fixed the same way Chief Brief was (see
// test/briefing-ai-chief-model-thinking.test.js, the template this file
// mirrors): an explicit, independently configurable ANTHROPIC_ASK_MODEL/
// ANTHROPIC_ASK_EFFORT/token-ceiling policy, plus an error-specific
// one-retry policy (askAnswer) that never returns or parses a truncated
// response, surfacing a stable sanitized AskGenerationError instead of an
// opaque 500 after retry exhaustion.
const test = require('node:test');
const assert = require('node:assert/strict');

const HEART_QUESTION = 'How would you rate my overall heart health for my age (33yo male)? What does it mean for longevity?';

function resetModules() {
  delete require.cache[require.resolve('../src/chat/ask')];
  delete require.cache[require.resolve('../src/llm')];
  delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  delete require.cache[require.resolve('../src/llm/providers/gemini')];
}

function truncatedResponse(id) {
  // Exactly the shape the production reproduction observed: thinking
  // consumed the entire budget, leaving NO text block at all.
  return { data: { id, content: [{ type: 'thinking', thinking: 'reasoning about cardiovascular risk factors...' }], stop_reason: 'max_tokens', usage: {} } };
}

test('askAnswer requests Sonnet 5, medium effort, adaptive thinking, 8192 initial maxTokens, pinned to the anthropic provider', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.ANTHROPIC_ASK_MODEL;
  delete process.env.ANTHROPIC_ASK_EFFORT;
  delete process.env.ANTHROPIC_ASK_MAX_TOKENS;
  const axios = require('axios');
  const originalPost = axios.post;
  let capturedBody = null;
  axios.post = async (url, body) => {
    capturedBody = body;
    return { data: { id: 'msg_ask_e2e', content: [{ type: 'text', text: 'A grounded, concise answer about cardiovascular health.' }], stop_reason: 'end_turn', usage: {} } };
  };
  try {
    resetModules();
    const { askAnswer } = require('../src/chat/ask');
    const text = await askAnswer({ system: 'You are NormOS.', prompt: HEART_QUESTION, route: 'chat' });
    assert.equal(text, 'A grounded, concise answer about cardiovascular health.');
    assert.equal(capturedBody.model, 'claude-sonnet-5');
    assert.deepEqual(capturedBody.thinking, { type: 'adaptive' }, 'extended thinking must actually be requested');
    assert.equal(capturedBody.max_tokens, 8192, 'initial ceiling');
    assert.ok(capturedBody.output_config, 'output_config must be present (effort requested)');
    assert.equal(capturedBody.output_config.effort, 'medium');
    assert.equal(capturedBody.tools, undefined, 'no forced tool call — Ask returns free-form prose');
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('a max_tokens truncation is retried exactly once, at the larger ceiling, and the retry result is returned', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  const capturedMaxTokens = [];
  let callCount = 0;
  axios.post = async (url, body) => {
    callCount++;
    capturedMaxTokens.push(body.max_tokens);
    if (callCount === 1) return truncatedResponse('msg_trunc_1');
    return { data: { id: 'msg_trunc_2', content: [{ type: 'text', text: 'A complete, unhurried answer that fit within the larger ceiling.' }], stop_reason: 'end_turn', usage: {} } };
  };
  try {
    resetModules();
    const { askAnswer } = require('../src/chat/ask');
    const text = await askAnswer({ system: 'You are NormOS.', prompt: HEART_QUESTION, route: 'chat' });
    assert.equal(callCount, 2, 'exactly one retry — two attempts total');
    assert.deepEqual(capturedMaxTokens, [8192, 16384], 'retry must use the LARGER ceiling, never the same insufficient limit');
    assert.equal(text, 'A complete, unhurried answer that fit within the larger ceiling.', 'the complete retry answer is returned, not anything from the truncated first attempt');
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('a max_tokens truncation on BOTH attempts throws AskGenerationError(ask_truncated) — never returns or lets a partial answer through', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  const capturedMaxTokens = [];
  let callCount = 0;
  axios.post = async (url, body) => {
    callCount++;
    capturedMaxTokens.push(body.max_tokens);
    return truncatedResponse(`msg_trunc_${callCount}`);
  };
  try {
    resetModules();
    const { askAnswer, AskGenerationError } = require('../src/chat/ask');
    await assert.rejects(
      () => askAnswer({ system: 'You are NormOS.', prompt: HEART_QUESTION, route: 'chat' }),
      (err) => {
        assert.ok(err instanceof AskGenerationError);
        assert.equal(err.code, 'ask_truncated');
        assert.equal(err.status, 503);
        return true;
      }
    );
    assert.equal(callCount, 2, 'exactly one retry, not more');
    assert.deepEqual(capturedMaxTokens, [8192, 16384]);
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('a refusal is NOT retried — exactly one attempt, throws AskGenerationError(ask_declined)', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  let callCount = 0;
  axios.post = async () => {
    callCount++;
    return { data: { id: `msg_refusal_${callCount}`, content: [], stop_reason: 'refusal', stop_details: { category: 'medical-advice' }, usage: {} } };
  };
  try {
    resetModules();
    const { askAnswer, AskGenerationError } = require('../src/chat/ask');
    await assert.rejects(
      () => askAnswer({ system: 'You are NormOS.', prompt: HEART_QUESTION, route: 'chat' }),
      (err) => {
        assert.ok(err instanceof AskGenerationError);
        assert.equal(err.code, 'ask_declined');
        assert.equal(err.status, 503);
        return true;
      }
    );
    assert.equal(callCount, 1, 'a refusal must not be retried with the identical request');
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('a persistent (non-refusal, non-max_tokens) provider failure retries once with the SAME ceiling, then throws AskGenerationError(ask_unavailable)', async () => {
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
    const { askAnswer, AskGenerationError } = require('../src/chat/ask');
    await assert.rejects(
      () => askAnswer({ system: 'You are NormOS.', prompt: HEART_QUESTION, route: 'chat' }),
      (err) => {
        assert.ok(err instanceof AskGenerationError);
        assert.equal(err.code, 'ask_unavailable');
        assert.equal(err.status, 503);
        return true;
      }
    );
    assert.equal(callCount, 2, 'exactly one retry');
    assert.deepEqual(capturedMaxTokens, [8192, 8192], 'a non-max_tokens failure must not bump maxTokens on retry');
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('a transient failure followed by a successful retry returns the retry answer (non-deterministic sampling can recover)', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  let callCount = 0;
  axios.post = async () => {
    callCount++;
    if (callCount === 1) throw new Error('ECONNRESET');
    return { data: { id: 'msg_recover', content: [{ type: 'text', text: 'Recovered on the second attempt.' }], stop_reason: 'end_turn', usage: {} } };
  };
  try {
    resetModules();
    const { askAnswer } = require('../src/chat/ask');
    const text = await askAnswer({ system: 'You are NormOS.', prompt: HEART_QUESTION, route: 'chat' });
    assert.equal(text, 'Recovered on the second attempt.');
    assert.equal(callCount, 2);
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('ANTHROPIC_ASK_MODEL/ANTHROPIC_ASK_EFFORT/ANTHROPIC_ASK_MAX_TOKENS override independently of ANTHROPIC_MODEL and ANTHROPIC_CHIEF_MODEL/ANTHROPIC_CHIEF_EFFORT (fast command settings also untouched)', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_MODEL = 'claude-opus-4-8'; // the global default — must NOT leak into Ask
  process.env.ANTHROPIC_CHIEF_MODEL = 'claude-opus-4-8'; // Chief Brief's own override — must NOT leak into Ask
  process.env.ANTHROPIC_CHIEF_EFFORT = 'xhigh';
  process.env.ANTHROPIC_FAST_MODEL = 'claude-haiku-4-5-20251001'; // fast command path — untouched by any of this
  process.env.ANTHROPIC_ASK_MODEL = 'claude-sonnet-4-6';
  process.env.ANTHROPIC_ASK_EFFORT = 'high';
  process.env.ANTHROPIC_ASK_MAX_TOKENS = '4096';
  process.env.ANTHROPIC_ASK_MAX_TOKENS_RETRY = '9000';
  const axios = require('axios');
  const originalPost = axios.post;
  let capturedBody = null;
  axios.post = async (url, body) => {
    capturedBody = body;
    return { data: { id: 'msg_override', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} } };
  };
  try {
    resetModules();
    const { askAnswer, ASK_MODEL, ASK_EFFORT, ASK_MAX_TOKENS_INITIAL, ASK_MAX_TOKENS_RETRY } = require('../src/chat/ask');
    assert.equal(ASK_MODEL, 'claude-sonnet-4-6');
    assert.equal(ASK_EFFORT, 'high');
    assert.equal(ASK_MAX_TOKENS_INITIAL, 4096);
    assert.equal(ASK_MAX_TOKENS_RETRY, 9000);
    await askAnswer({ system: 'sys', prompt: HEART_QUESTION, route: 'chat' });
    assert.equal(capturedBody.model, 'claude-sonnet-4-6');
    assert.equal(capturedBody.output_config.effort, 'high');
    assert.equal(capturedBody.max_tokens, 4096);
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('an invalid ANTHROPIC_ASK_EFFORT fails loudly at require time, not with a paid 400 request', () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_ASK_EFFORT = 'ultra-max-plus';
  try {
    resetModules();
    assert.throws(() => require('../src/chat/ask'), /Invalid ANTHROPIC_ASK_EFFORT/);
  } finally {
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('LLM_PROVIDER=gemini does not change which provider Ask uses — it stays pinned to anthropic', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.LLM_PROVIDER = 'gemini';
  try {
    resetModules();
    const gemini = require('../src/llm/providers/gemini');
    const originalGeminiGenerate = gemini.generateText;
    let geminiCalled = false;
    gemini.generateText = async () => { geminiCalled = true; throw new Error('gemini should never be called for Ask'); };

    const axios = require('axios');
    const originalPost = axios.post;
    let capturedUrl = null;
    axios.post = async (url) => {
      capturedUrl = url;
      return { data: { id: 'msg_gemini_guard', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} } };
    };
    try {
      const { askAnswer } = require('../src/chat/ask');
      const text = await askAnswer({ system: 'sys', prompt: HEART_QUESTION, route: 'chat' });
      assert.equal(geminiCalled, false, 'gemini.generateText must never be invoked for Ask');
      assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages');
      assert.equal(text, 'ok');
    } finally {
      axios.post = originalPost;
      gemini.generateText = originalGeminiGenerate;
    }
  } finally {
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});

test('logging never includes the question, the answer, or the API key — only safe metadata', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-super-secret-test-key-do-not-leak';
  const axios = require('axios');
  const originalPost = axios.post;
  let callCount = 0;
  axios.post = async () => {
    callCount++;
    if (callCount === 1) return truncatedResponse('msg_log_1');
    return { data: { id: 'msg_log_2', content: [{ type: 'text', text: 'Sensitive cardiovascular details that must never appear in a log line.' }], stop_reason: 'end_turn', usage: {} } };
  };
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.map(String).join(' '));
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    resetModules();
    const { askAnswer } = require('../src/chat/ask');
    await askAnswer({ system: 'sys', prompt: HEART_QUESTION, route: 'chat' });
    assert.ok(lines.length > 0, 'the attempts must be logged');
    for (const line of lines) {
      assert.ok(!line.includes(HEART_QUESTION), `log line leaked the question: ${line}`);
      assert.ok(!line.includes('Sensitive cardiovascular details'), `log line leaked the answer: ${line}`);
      assert.ok(!line.includes('sk-ant-super-secret-test-key-do-not-leak'), `log line leaked the API key: ${line}`);
    }
    const combined = lines.join(' | ');
    assert.match(combined, /route=chat/);
    assert.match(combined, /model=claude-sonnet-5/);
    assert.match(combined, /effort=medium/);
    assert.match(combined, /maxTokens=(8192|16384)/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    resetModules();
  }
});
