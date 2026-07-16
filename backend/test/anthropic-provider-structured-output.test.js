// Provider-level coverage for the two mechanisms `generateText` can use to
// guarantee response shape:
//   - jsonMode+jsonSchema: forces a tool_choice tool call. Older, still used
//     by some callers (e.g. the weekly-review call) — incompatible with
//     extended thinking, unaffected by this change.
//   - outputSchema+effort: native Structured Outputs (output_config.format).
//     Newer, composes with extended thinking — added for the chief-brief
//     call. See briefing-ai-chief-model-thinking.test.js for the caller-side
//     (briefing-ai.js) coverage; this file covers the provider mechanics
//     directly: request shape and refusal/max_tokens handling, both of which
//     apply to every caller, not just chief-brief.
const test = require('node:test');
const assert = require('node:assert/strict');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { answer: { type: 'string' } },
  required: ['answer'],
};

function freshProvider() {
  delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  return require('../src/llm/providers/anthropic');
}

test('outputSchema+effort produce output_config.format + effort, thinking stays on, no forced tool', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  let capturedBody = null;
  axios.post = async (url, body) => {
    capturedBody = body;
    return { data: { content: [{ type: 'text', text: '{"answer":"ok"}' }], stop_reason: 'end_turn', usage: {} } };
  };
  try {
    const anthropic = freshProvider();
    const text = await anthropic.generateText({
      system: 'sys', prompt: 'hello', outputSchema: SCHEMA, effort: 'high',
    });
    assert.equal(text, '{"answer":"ok"}');
    assert.deepEqual(capturedBody.thinking, { type: 'adaptive' });
    assert.equal(capturedBody.tools, undefined);
    assert.equal(capturedBody.tool_choice, undefined);
    assert.deepEqual(capturedBody.output_config, { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } });
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  }
});

test('the older forced-tool jsonMode+jsonSchema path is unaffected: no output_config, no thinking', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  let capturedBody = null;
  axios.post = async (url, body) => {
    capturedBody = body;
    return {
      data: {
        content: [{ type: 'tool_use', name: 'submit_result', input: { answer: 'ok' } }],
        stop_reason: 'tool_use',
        usage: {},
      },
    };
  };
  try {
    const anthropic = freshProvider();
    const text = await anthropic.generateText({
      system: 'sys', prompt: 'hello', jsonMode: true, jsonSchema: SCHEMA,
    });
    assert.equal(text, JSON.stringify({ answer: 'ok' }));
    assert.equal(capturedBody.thinking, undefined, 'forced tool_choice still omits thinking');
    assert.equal(capturedBody.output_config, undefined);
    assert.deepEqual(capturedBody.tool_choice, { type: 'tool', name: 'submit_result' });
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  }
});

test('stop_reason "refusal" throws AnthropicRefusalError carrying stop_details.category', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = async () => ({
    data: { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio' }, usage: {} },
  });
  try {
    const anthropic = freshProvider();
    await assert.rejects(
      () => anthropic.generateText({ system: 'sys', prompt: 'hello' }),
      (err) => {
        assert.ok(err instanceof anthropic.AnthropicRefusalError);
        assert.equal(err.category, 'bio');
        return true;
      }
    );
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  }
});

test('stop_reason "refusal" with no stop_details still throws, with category null', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = async () => ({ data: { content: [], stop_reason: 'refusal', usage: {} } });
  try {
    const anthropic = freshProvider();
    await assert.rejects(
      () => anthropic.generateText({ system: 'sys', prompt: 'hello' }),
      (err) => {
        assert.ok(err instanceof anthropic.AnthropicRefusalError);
        assert.equal(err.category, null);
        return true;
      }
    );
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  }
});

test('stop_reason "max_tokens" throws AnthropicMaxTokensError instead of returning truncated text', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = async () => ({
    data: { content: [{ type: 'text', text: '{"answer": "cut off' }], stop_reason: 'max_tokens', usage: {} },
  });
  try {
    const anthropic = freshProvider();
    await assert.rejects(
      () => anthropic.generateText({ system: 'sys', prompt: 'hello' }),
      (err) => {
        assert.ok(err instanceof anthropic.AnthropicMaxTokensError);
        return true;
      }
    );
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  }
});

test('normal end_turn responses are unaffected by the refusal/max_tokens guard', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = async () => ({
    data: { content: [{ type: 'text', text: 'a normal reply' }], stop_reason: 'end_turn', usage: {} },
  });
  try {
    const anthropic = freshProvider();
    const text = await anthropic.generateText({ system: 'sys', prompt: 'hello' });
    assert.equal(text, 'a normal reply');
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  }
});

test('returnMeta: true returns {text, stopReason, requestId, model} instead of a bare string; default stays a bare string', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = async () => ({
    data: { id: 'msg_01abc', content: [{ type: 'text', text: 'hello back' }], stop_reason: 'end_turn', usage: {} },
  });
  try {
    const anthropic = freshProvider();
    const withMeta = await anthropic.generateText({ system: 'sys', prompt: 'hi', model: 'claude-opus-4-8', returnMeta: true });
    assert.deepEqual(withMeta, { text: 'hello back', stopReason: 'end_turn', requestId: 'msg_01abc', model: 'claude-opus-4-8' });

    const bare = await anthropic.generateText({ system: 'sys', prompt: 'hi', model: 'claude-opus-4-8' });
    assert.equal(bare, 'hello back', 'without returnMeta, the return value is still a bare string (backward compatible)');
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  }
});

test('AnthropicRefusalError and AnthropicMaxTokensError carry only safe metadata (requestId, model, counts) — never content', async () => {
  const ORIGINAL_ENV = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const axios = require('axios');
  const originalPost = axios.post;
  try {
    const anthropic = freshProvider();

    axios.post = async () => ({
      data: { id: 'msg_refused1', content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' }, usage: {} },
    });
    await assert.rejects(
      () => anthropic.generateText({ system: 'sys', prompt: 'hello', model: 'claude-opus-4-8' }),
      (err) => {
        assert.equal(err.requestId, 'msg_refused1');
        assert.equal(err.model, 'claude-opus-4-8');
        return true;
      }
    );

    axios.post = async () => ({
      data: { id: 'msg_trunc1', content: [{ type: 'text', text: 'a very sensitive secret partial answer' }], stop_reason: 'max_tokens', usage: {} },
    });
    await assert.rejects(
      () => anthropic.generateText({ system: 'sys', prompt: 'hello', model: 'claude-opus-4-8', maxTokens: 4096 }),
      (err) => {
        assert.equal(err.requestId, 'msg_trunc1');
        assert.equal(err.model, 'claude-opus-4-8');
        assert.equal(err.maxTokens, 4096);
        assert.equal(err.responseLength, 'a very sensitive secret partial answer'.length);
        // The error's own message/fields must never contain the truncated text itself.
        assert.ok(!err.message.includes('sensitive secret'));
        assert.ok(!JSON.stringify(err).includes('sensitive secret'));
        return true;
      }
    );
  } finally {
    axios.post = originalPost;
    process.env = ORIGINAL_ENV;
    delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  }
});
