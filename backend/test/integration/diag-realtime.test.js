// GET /api/diag/realtime — the safe, admin-gated diagnostic added to debug
// the production "Live voice isn't available right now" report from the
// ACTUAL running process rather than assumptions: is OPENAI_API_KEY present/
// well-formed, is VOICE_REALTIME_ENABLED on, and does a REAL call to
// OpenAI's client_secrets endpoint succeed. Never returns the key, the
// ephemeral secret, or any raw request/response body.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const axios = require('axios');
const { buildTestApp, ADMIN_TOKEN, closeDb } = require('./helpers');

const app = buildTestApp();
const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_AXIOS_POST = axios.post;

afterEach(() => {
  process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
  axios.post = ORIGINAL_AXIOS_POST;
});

after(async () => {
  await closeDb();
});

test('GET /api/diag/realtime requires the admin token, not just the general app token', async () => {
  const res = await request(app).get('/api/diag/realtime');
  assert.equal(res.status, 401);
});

test('reports openaiKeyConfigured:false and skips the live probe when no key is set', async () => {
  delete process.env.OPENAI_API_KEY;
  const res = await request(app).get('/api/diag/realtime').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.openaiKeyConfigured, false);
  assert.equal(res.body.liveProbe.ok, false);
  assert.equal(res.body.liveProbe.reason, 'openai_not_configured');
});

test('flags surrounding whitespace on the key without ever revealing the key itself', async () => {
  process.env.OPENAI_API_KEY = '  sk-has-leading-and-trailing-space  ';
  axios.post = async () => { const e = new Error('bad'); e.response = { status: 401, data: { error: { message: 'bad key' } } }; throw e; };
  const res = await request(app).get('/api/diag/realtime').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  assert.equal(res.body.openaiKeyConfigured, true);
  assert.equal(res.body.openaiKeyHasSurroundingWhitespace, true);
  assert.ok(!JSON.stringify(res.body).includes('sk-has-leading-and-trailing-space'), 'the key itself must never appear in the response');
});

test('a successful live probe reports liveProbe.ok:true without leaking the minted ephemeral secret', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  axios.post = async () => ({ data: { value: 'ek_should_never_appear_in_diag_response', expires_at: 123 } });
  const res = await request(app).get('/api/diag/realtime').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.liveProbe.ok, true);
  assert.ok(!JSON.stringify(res.body).includes('ek_should_never_appear_in_diag_response'));
});

test('a failed live probe reports the classified reason and safe provider detail, never the raw response body', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  axios.post = async () => {
    const err = new Error('Incorrect API key provided: sk-test-key');
    err.response = { status: 401, data: { error: { message: 'Incorrect API key provided: sk-test-key', type: 'invalid_request_error' } } };
    throw err;
  };
  const res = await request(app).get('/api/diag/realtime').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  assert.equal(res.body.liveProbe.ok, false);
  assert.equal(res.body.liveProbe.reason, 'openai_auth_failed');
  assert.equal(res.body.liveProbe.providerStatus, 401);
  assert.ok(!JSON.stringify(res.body).includes('sk-test-key'), 'the key must never appear even inside a provider error message echo');
});

test('reports voiceRealtimeEnabled false when the kill switch is set', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  process.env.VOICE_REALTIME_ENABLED = 'false';
  axios.post = async () => ({ data: { value: 'ek_x' } });
  const res = await request(app).get('/api/diag/realtime').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  assert.equal(res.body.voiceRealtimeEnabled, false);
  delete process.env.VOICE_REALTIME_ENABLED;
});
