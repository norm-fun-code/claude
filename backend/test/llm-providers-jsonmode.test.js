// jsonMode support added to the Anthropic and Gemini providers (see the
// engineering review's #4) — constrains generation to guaranteed-valid JSON
// server-side instead of relying purely on a prompt instruction the model
// can ignore. Mocks axios.post since these providers call the raw HTTP APIs
// directly (no SDK).
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const ORIGINAL_ENV = { ...process.env };
test.afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

test('anthropic: jsonMode + jsonSchema forces a single tool call and omits extended thinking', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  const anthropic = require('../src/llm/providers/anthropic');

  let capturedBody = null;
  const originalPost = axios.post;
  axios.post = async (url, body) => {
    capturedBody = body;
    return {
      data: {
        content: [{ type: 'tool_use', name: 'submit_result', input: { chiefBrief: { synthesis: 'x' } } }],
        usage: {},
      },
    };
  };
  try {
    const schema = { type: 'object', properties: { chiefBrief: { type: 'object' } } };
    const result = await anthropic.generateText({
      system: 'sys', prompt: 'p', jsonMode: true, jsonSchema: schema,
    });
    assert.equal(result, JSON.stringify({ chiefBrief: { synthesis: 'x' } }));
    assert.deepEqual(capturedBody.tool_choice, { type: 'tool', name: 'submit_result' });
    assert.equal(capturedBody.tools[0].input_schema, schema);
    assert.equal(capturedBody.thinking, undefined, 'forced tool_choice is incompatible with extended thinking');
  } finally {
    axios.post = originalPost;
  }
});

test('anthropic: without jsonSchema, jsonMode alone does not force a tool (no native schema-less JSON mode)', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  const anthropic = require('../src/llm/providers/anthropic');

  let capturedBody = null;
  const originalPost = axios.post;
  axios.post = async (url, body) => {
    capturedBody = body;
    return { data: { content: [{ type: 'text', text: '{"a":1}' }], usage: {} } };
  };
  try {
    const result = await anthropic.generateText({ system: 'sys', prompt: 'p', jsonMode: true });
    assert.equal(result, '{"a":1}');
    assert.equal(capturedBody.tools, undefined);
    assert.deepEqual(capturedBody.thinking, { type: 'adaptive' }, 'thinking still applies on the normal (non-forced-tool) path');
  } finally {
    axios.post = originalPost;
  }
});

test('anthropic: normal (non-jsonMode) calls are unaffected', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete require.cache[require.resolve('../src/llm/providers/anthropic')];
  const anthropic = require('../src/llm/providers/anthropic');

  let capturedBody = null;
  const originalPost = axios.post;
  axios.post = async (url, body) => {
    capturedBody = body;
    return { data: { content: [{ type: 'text', text: 'plain answer' }], usage: {} } };
  };
  try {
    const result = await anthropic.generateText({ system: 'sys', prompt: 'p' });
    assert.equal(result, 'plain answer');
    assert.equal(capturedBody.tools, undefined);
    assert.deepEqual(capturedBody.thinking, { type: 'adaptive' });
  } finally {
    axios.post = originalPost;
  }
});

test('gemini: jsonMode sets responseMimeType to application/json', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  delete require.cache[require.resolve('../src/llm/providers/gemini')];
  const gemini = require('../src/llm/providers/gemini');

  let capturedBody = null;
  const originalPost = axios.post;
  axios.post = async (url, body) => {
    capturedBody = body;
    return { data: { candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] } };
  };
  try {
    const result = await gemini.generateText({ system: 'sys', prompt: 'p', jsonMode: true });
    assert.equal(result, '{"a":1}');
    assert.equal(capturedBody.generationConfig.responseMimeType, 'application/json');
  } finally {
    axios.post = originalPost;
  }
});

test('gemini: without jsonMode, responseMimeType is not set', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  delete require.cache[require.resolve('../src/llm/providers/gemini')];
  const gemini = require('../src/llm/providers/gemini');

  let capturedBody = null;
  const originalPost = axios.post;
  axios.post = async (url, body) => {
    capturedBody = body;
    return { data: { candidates: [{ content: { parts: [{ text: 'plain text' }] } }] } };
  };
  try {
    await gemini.generateText({ system: 'sys', prompt: 'p' });
    assert.equal(capturedBody.generationConfig.responseMimeType, undefined);
  } finally {
    axios.post = originalPost;
  }
});
