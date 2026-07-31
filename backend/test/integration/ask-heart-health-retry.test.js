// Production bug: POST /api/chat returned a bare 500 for
//   "How would you rate my overall heart health for my age (33yo male)?
//    What does it mean for longevity?"
// Root cause (confirmed via a faithful reproduction against the real,
// unmodified ask() before this fix): the reasoning call ran with no
// model/effort override and only maxTokens:1600; Sonnet 5's adaptive
// thinking shares max_tokens with the visible answer, so thinking alone
// exhausted the budget — stop_reason 'max_tokens', zero text output —
// thrown as AnthropicMaxTokensError, uncaught through asyncHandler to a
// bare 500. See test/ask-generation.test.js for the unit-level retry-policy
// coverage (askAttempt/askAnswer in isolation); this file proves the same
// behavior end-to-end through the REAL Express route + REAL Postgres, with
// the exact reported question, exactly as a live client would see it.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');

const HEART_QUESTION = 'How would you rate my overall heart health for my age (33yo male)? What does it mean for longevity?';
const app = buildTestApp();

const ORIGINAL_ENV = { ...process.env };
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const axios = require('axios');
const originalAxiosPost = axios.post;

function truncatedResponse(id) {
  return { data: { id, content: [{ type: 'thinking', thinking: 'weighing cardiovascular risk factors...' }], stop_reason: 'max_tokens', usage: {} } };
}

async function messageCountFor(content) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM chat_messages WHERE content = $1', [content]);
  return rows[0].n;
}

afterEach(async () => {
  axios.post = originalAxiosPost;
  process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  // Clean up anything this file wrote to the shared chat thread so it never
  // pollutes another integration test's chat_messages/conversations state.
  await db.query('DELETE FROM chat_messages WHERE content = $1', [HEART_QUESTION]);
  await db.query(`DELETE FROM chat_messages WHERE content LIKE 'ASK-HEALTH-TEST-MARKER-%'`);
});
after(async () => { await closeDb(); });

test('POST /api/chat: first call truncated at max_tokens, retry succeeds at the larger ceiling -> 200 with the complete answer, exactly one retry, and the turn IS persisted', async () => {
  const capturedMaxTokens = [];
  let callCount = 0;
  const FULL_ANSWER = 'ASK-HEALTH-TEST-MARKER-ok Based on your resting HR and HRV trends, your cardiovascular indicators look solid for your age — I do not have enough long-term data to make a longevity claim, so treat this as a snapshot, not a diagnosis. Consider a professional lipid panel if you have not had one recently.';
  axios.post = async (url, body) => {
    callCount++;
    capturedMaxTokens.push(body.max_tokens);
    if (callCount === 1) return truncatedResponse('msg_int_trunc_1');
    return { data: { id: 'msg_int_trunc_2', content: [{ type: 'text', text: FULL_ANSWER }], stop_reason: 'end_turn', usage: {} } };
  };

  const res = await request(app).post('/api/chat').set(authHeader()).send({ question: HEART_QUESTION });

  assert.equal(res.status, 200);
  assert.equal(res.body.answer, FULL_ANSWER, 'the client receives the COMPLETE retry answer, never the truncated first attempt');
  assert.equal(callCount, 2, 'exactly one retry — two attempts total');
  assert.deepEqual(capturedMaxTokens, [8192, 16384], 'retry uses the larger ceiling, never the same insufficient limit');

  // Ticket 9: the 200 is not sent until the complete user+assistant turn
  // committed. This must be true synchronously; polling would hide the old
  // fire-and-forget failure mode where a process restart lost history.
  const saved = await messageCountFor(HEART_QUESTION);
  assert.equal(saved, 1, 'the successful turn was persisted to chat history');
});

test('POST /api/chat: max_tokens truncation on BOTH attempts -> 503 with a stable sanitized code, no raw provider error text, and NOTHING saved', async () => {
  const before = await messageCountFor(HEART_QUESTION);
  let callCount = 0;
  axios.post = async () => { callCount++; return truncatedResponse(`msg_int_persist_trunc_${callCount}`); };

  const res = await request(app).post('/api/chat').set(authHeader()).send({ question: HEART_QUESTION });

  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'ask_truncated');
  assert.equal(typeof res.body.error, 'string');
  assert.ok(!res.body.error.includes('AnthropicMaxTokensError'), 'must not leak the internal error class name');
  assert.ok(!res.body.error.includes('msg_int_persist_trunc'), 'must not leak the raw Anthropic request id in the message');
  assert.equal(callCount, 2, 'exactly one retry, not more');

  await new Promise((r) => setTimeout(r, 150)); // let any (incorrect) fire-and-forget save settle before asserting absence
  const after1 = await messageCountFor(HEART_QUESTION);
  assert.equal(after1, before, 'no partial/truncated turn was saved to chat history');
});

test('POST /api/chat: a refusal -> 503 with code ask_declined, not retried, nothing saved', async () => {
  const before = await messageCountFor(HEART_QUESTION);
  let callCount = 0;
  axios.post = async () => {
    callCount++;
    return { data: { id: `msg_int_refusal_${callCount}`, content: [], stop_reason: 'refusal', stop_details: { category: 'medical-advice' }, usage: {} } };
  };

  const res = await request(app).post('/api/chat').set(authHeader()).send({ question: HEART_QUESTION });

  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'ask_declined');
  assert.equal(callCount, 1, 'a refusal must not be retried');

  await new Promise((r) => setTimeout(r, 150));
  const after1 = await messageCountFor(HEART_QUESTION);
  assert.equal(after1, before, 'nothing saved on a declined answer');
});

test('POST /api/chat: persistent provider failure (both attempts) -> 503 with code ask_unavailable, nothing saved', async () => {
  const before = await messageCountFor(HEART_QUESTION);
  let callCount = 0;
  axios.post = async () => { callCount++; throw new Error('socket hang up'); };

  const res = await request(app).post('/api/chat').set(authHeader()).send({ question: HEART_QUESTION });

  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'ask_unavailable');
  assert.ok(!res.body.error.includes('socket hang up'), 'must not leak the raw transport error text');
  assert.equal(callCount, 2);

  await new Promise((r) => setTimeout(r, 150));
  const after1 = await messageCountFor(HEART_QUESTION);
  assert.equal(after1, before, 'nothing saved after retry exhaustion');
});
