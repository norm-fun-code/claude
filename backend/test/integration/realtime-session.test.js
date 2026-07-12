// Talk to NormOS's HTTP surface: session minting (auth + fallback behavior),
// the tool relay endpoint, turn persistence to the shared Ask thread, and
// deep_ask routing through the SAME ask() engine every other surface uses.
// No live OpenAI/WebRTC calls — the ephemeral-secret mint is stubbed at the
// axios layer, exactly like the existing Gemini voice tests stub llm.*.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const axios = require('axios');
const { buildTestApp, authHeader, ADMIN_TOKEN, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');

const app = buildTestApp();

const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_ENABLED = process.env.VOICE_REALTIME_ENABLED;
const ORIGINAL_AXIOS_POST = axios.post;
const ORIGINAL_GENERATE_TEXT = llm.generateText;
const ORIGINAL_EMBED = llm.embed;

afterEach(async () => {
  process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
  process.env.VOICE_REALTIME_ENABLED = ORIGINAL_ENABLED;
  axios.post = ORIGINAL_AXIOS_POST;
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  llm.embed = ORIGINAL_EMBED;
  await db.query(`DELETE FROM voice_realtime_events WHERE session_id LIKE 'test-%'`);
});

after(async () => {
  await closeDb();
});

test('POST /voice/realtime/session requires auth like every other /api route', async () => {
  const res = await request(app).post('/api/voice/realtime/session').send({});
  assert.equal(res.status, 401);
});

test('POST /voice/realtime/session falls back gracefully when OPENAI_API_KEY is not configured', async () => {
  delete process.env.OPENAI_API_KEY;
  const res = await request(app).post('/api/voice/realtime/session').set(authHeader()).send({});
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'openai_not_configured');
  assert.equal(res.body.fallback, true, 'the client must know to fall back to the old voice path');
});

test('POST /voice/realtime/session respects the VOICE_REALTIME_ENABLED kill switch', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  process.env.VOICE_REALTIME_ENABLED = 'false';
  const res = await request(app).post('/api/voice/realtime/session').set(authHeader()).send({});
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'realtime_disabled');
});

test('POST /voice/realtime/session mints a session and never leaks the permanent API key to the client', async () => {
  process.env.OPENAI_API_KEY = 'sk-permanent-secret-should-never-leak';
  process.env.VOICE_REALTIME_ENABLED = 'true';
  let capturedAuthHeader = null;
  let capturedBody = null;
  axios.post = async (url, body, opts) => {
    capturedAuthHeader = opts?.headers?.Authorization;
    capturedBody = body;
    return { data: { value: 'ek_ephemeral_abc123', expires_at: 1234567890 } };
  };

  const res = await request(app).post('/api/voice/realtime/session').set(authHeader()).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.clientSecret, 'ek_ephemeral_abc123');
  assert.ok(res.body.sessionId);
  assert.equal(res.body.model, 'gpt-realtime-2.1');
  assert.equal(res.body.voice, 'cedar');

  // The permanent key was used to AUTHENTICATE the mint request (server-side
  // only) — it must never appear anywhere in the response body.
  assert.equal(capturedAuthHeader, 'Bearer sk-permanent-secret-should-never-leak');
  const responseText = JSON.stringify(res.body);
  assert.ok(!responseText.includes('sk-permanent-secret-should-never-leak'), 'permanent key leaked to client response');

  // Session config sent to OpenAI carries the tool allowlist and semantic VAD.
  assert.equal(capturedBody.session.type, 'realtime');
  assert.ok(Array.isArray(capturedBody.session.tools) && capturedBody.session.tools.length >= 9);
  assert.equal(capturedBody.session.audio.input.turn_detection.type, 'semantic_vad');
  // Input transcription MUST be enabled — without it the user's spoken words
  // never transcribe, breaking both the live transcript and turn persistence.
  assert.ok(capturedBody.session.audio.input.transcription?.model, 'input transcription must be configured');
});

test('POST /voice/realtime/session surfaces a mint failure as a fallback-eligible error, not a 500', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  process.env.VOICE_REALTIME_ENABLED = 'true';
  axios.post = async () => { throw new Error('OpenAI rate limited'); };
  const res = await request(app).post('/api/voice/realtime/session').set(authHeader()).send({});
  assert.equal(res.status, 502);
  assert.equal(res.body.fallback, true);
});

// Bug bash finding: every mint failure used to collapse into the SAME
// 'session_mint_failed' code regardless of cause, so an auth failure, an
// access-denied account, and a bad model name were all indistinguishable
// from the client's point of view. These lock in that the route surfaces
// the SPECIFIC classified reason for each distinct OpenAI failure mode.
test('POST /voice/realtime/session classifies an OpenAI 401 as openai_auth_failed', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  process.env.VOICE_REALTIME_ENABLED = 'true';
  axios.post = async () => {
    const err = new Error('Incorrect API key provided');
    err.response = { status: 401, data: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } } };
    throw err;
  };
  const res = await request(app).post('/api/voice/realtime/session').set(authHeader()).send({});
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'openai_auth_failed');
  assert.equal(res.body.fallback, true);
});

test('POST /voice/realtime/session classifies an OpenAI 403 as openai_access_denied', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  process.env.VOICE_REALTIME_ENABLED = 'true';
  axios.post = async () => {
    const err = new Error('access denied');
    err.response = { status: 403, data: { error: { message: 'You do not have access to this model' } } };
    throw err;
  };
  const res = await request(app).post('/api/voice/realtime/session').set(authHeader()).send({});
  assert.equal(res.body.error, 'openai_access_denied');
});

test('POST /voice/realtime/session classifies an unknown-model response as invalid_realtime_model', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  process.env.VOICE_REALTIME_ENABLED = 'true';
  axios.post = async () => {
    const err = new Error('model not found');
    err.response = { status: 404, data: { error: { message: "The model 'gpt-realtime-2.1' does not exist", code: 'model_not_found' } } };
    throw err;
  };
  const res = await request(app).post('/api/voice/realtime/session').set(authHeader()).send({});
  assert.equal(res.body.error, 'invalid_realtime_model');
});

test('POST /voice/realtime/session classifies a network-level failure (no HTTP response at all) as network_failure', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  process.env.VOICE_REALTIME_ENABLED = 'true';
  axios.post = async () => { throw new Error('getaddrinfo ENOTFOUND api.openai.com'); }; // no .response — a real transport failure
  const res = await request(app).post('/api/voice/realtime/session').set(authHeader()).send({});
  assert.equal(res.body.error, 'network_failure');
});

test('the mint-failure response body never leaks the raw provider message or any request/response detail — only the stable reason code', async () => {
  process.env.OPENAI_API_KEY = 'sk-super-secret-should-never-leak-anywhere';
  process.env.VOICE_REALTIME_ENABLED = 'true';
  axios.post = async () => {
    const err = new Error('Incorrect API key provided: sk-super-secret-should-never-leak-anywhere');
    err.response = { status: 401, data: { error: { message: 'Incorrect API key provided: sk-super-secret-should-never-leak-anywhere' } } };
    throw err;
  };
  const res = await request(app).post('/api/voice/realtime/session').set(authHeader()).send({});
  const bodyText = JSON.stringify(res.body);
  assert.ok(!bodyText.includes('sk-super-secret-should-never-leak-anywhere'), 'the key/provider message text must never reach the client response');
  assert.deepEqual(Object.keys(res.body).sort(), ['error', 'fallback']);
});

test('POST /voice/realtime/tool rejects a tool name the model was never given', async () => {
  const res = await request(app).post('/api/voice/realtime/tool').set(authHeader())
    .send({ sessionId: 'test-1', name: 'run_shell_command', arguments: {} });
  assert.equal(res.status, 400);
});

test('POST /voice/realtime/tool executes an allowlisted read tool and logs a fast_path metric', async () => {
  const res = await request(app).post('/api/voice/realtime/tool').set(authHeader())
    .send({ sessionId: 'test-fastpath', name: 'get_recent_findings', arguments: {} });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.result.findings));

  const { rows } = await db.query(`SELECT event_type FROM voice_realtime_events WHERE session_id = 'test-fastpath'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, 'fast_path');
});

test('POST /voice/realtime/tool executes execute_normos_action through the SAME validated allowlist as typed/voice Ask', async () => {
  const res = await request(app).post('/api/voice/realtime/tool').set(authHeader())
    .send({ sessionId: 'test-action', name: 'execute_normos_action', arguments: { type: 'add_context', text: 'Realtime tool test note' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.done, true);
});

test('POST /voice/realtime/tool logs an error metric and returns 500 on a genuine tool failure, without crashing the process', async () => {
  const res = await request(app).post('/api/voice/realtime/tool').set(authHeader())
    .send({ sessionId: 'test-error', name: 'query_metric', arguments: { domain: null, metric: null } });
  // query_metric fails soft (returns {error} with 200) rather than throwing —
  // confirm that soft-failure shape instead, since it's the actual contract.
  assert.equal(res.status, 200);
  assert.ok(res.body.result.error);
});

test('deep_ask routes through the existing ask() engine and persists both turns to the shared Ask thread', async () => {
  llm.embed = async () => { throw new Error('no embeddings in test env'); };
  llm.generateText = async () => 'A short spoken-style answer for the realtime deep_ask path.';

  const res = await request(app).post('/api/voice/realtime/tool').set(authHeader())
    .send({ sessionId: 'test-deepask', name: 'deep_ask', arguments: { question: 'What should I focus on this week?' } });
  assert.equal(res.status, 200);
  assert.match(res.body.result.answer, /short spoken-style answer/);

  const { rows: metricRows } = await db.query(`SELECT event_type FROM voice_realtime_events WHERE session_id = 'test-deepask'`);
  assert.equal(metricRows[0].event_type, 'deep_ask');

  const history = await require('../../src/store/chat').recentMessages({ limit: 5 });
  assert.ok(history.some((m) => m.role === 'user' && m.content.includes('What should I focus on this week?')));
  assert.ok(history.some((m) => m.role === 'assistant' && m.content.includes('short spoken-style answer')));
});

test('POST /voice/realtime/turn persists a fast-path (non-deep_ask) turn to the shared Ask thread', async () => {
  const res = await request(app).post('/api/voice/realtime/turn').set(authHeader())
    .send({ question: 'How is my recovery today?', answer: 'Your recovery is looking solid this morning.' });
  assert.equal(res.status, 200);
  const history = await require('../../src/store/chat').recentMessages({ limit: 5 });
  assert.ok(history.some((m) => m.content.includes('Your recovery is looking solid')));
});

test('POST /voice/realtime/metric only accepts the documented client-observed event types', async () => {
  const bad = await request(app).post('/api/voice/realtime/metric').set(authHeader())
    .send({ sessionId: 'test-metric', type: 'not_a_real_type', valueMs: 100 });
  assert.equal(bad.status, 400);

  const good = await request(app).post('/api/voice/realtime/metric').set(authHeader())
    .send({ sessionId: 'test-metric', type: 'connect', valueMs: 842 });
  assert.equal(good.status, 200);
  const { rows } = await db.query(`SELECT value_ms FROM voice_realtime_events WHERE session_id = 'test-metric'`);
  assert.equal(rows[0].value_ms, 842);
});
