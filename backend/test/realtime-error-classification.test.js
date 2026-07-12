// Bug bash finding: the mobile "Talk to NormOS" UI collapsed EVERY session-
// mint failure into one generic "Live voice isn't available right now"
// message with no Retry button, making a real production outage (bad key,
// wrong model, access denied, network blip) indistinguishable from a
// deliberate feature flag. classifyError() is the backend half of the fix:
// it turns an axios error from the OpenAI call into one of the documented,
// stable reason codes the mobile client maps to a specific message. Pure —
// no network call, exercises every branch directly against a hand-built
// axios-shaped error object.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyError, redactKeyFragments } = require('../src/services/realtime');

function axiosError({ status, code, type, param, message } = {}, { noResponse = false } = {}) {
  const err = new Error(message || 'request failed');
  if (!noResponse) {
    err.response = { status, data: { error: { code, type, param, message } } };
  }
  return err;
}

test('no HTTP response at all (timeout, DNS failure, offline) classifies as network_failure', () => {
  const err = axiosError({}, { noResponse: true });
  const c = classifyError(err);
  assert.equal(c.reason, 'network_failure');
  assert.equal(c.providerStatus, null);
});

test('401 classifies as openai_auth_failed', () => {
  const c = classifyError(axiosError({ status: 401, type: 'invalid_request_error', message: 'Incorrect API key provided' }));
  assert.equal(c.reason, 'openai_auth_failed');
  assert.equal(c.providerStatus, 401);
});

test('403 classifies as openai_access_denied', () => {
  const c = classifyError(axiosError({ status: 403, message: 'You do not have access to this resource' }));
  assert.equal(c.reason, 'openai_access_denied');
});

test('404 classifies as invalid_realtime_model', () => {
  const c = classifyError(axiosError({ status: 404, message: 'model not found' }));
  assert.equal(c.reason, 'invalid_realtime_model');
});

test('a 400 whose provider code names the model classifies as invalid_realtime_model', () => {
  const c = classifyError(axiosError({ status: 400, code: 'model_not_found', message: "The model 'gpt-realtime-2.1' does not exist" }));
  assert.equal(c.reason, 'invalid_realtime_model');
  assert.equal(c.providerCode, 'model_not_found');
});

test('a 400 whose provider param references session.model classifies as invalid_realtime_model', () => {
  const c = classifyError(axiosError({ status: 400, param: 'session.model', message: 'Invalid value for session.model' }));
  assert.equal(c.reason, 'invalid_realtime_model');
});

test('an unrelated 400 (e.g. a malformed tools schema) classifies as the generic session_mint_failed', () => {
  const c = classifyError(axiosError({ status: 400, code: 'invalid_request_error', param: 'session.tools', message: 'tools[0].parameters is invalid' }));
  assert.equal(c.reason, 'session_mint_failed');
});

test('a 500 from OpenAI classifies as session_mint_failed', () => {
  const c = classifyError(axiosError({ status: 500, message: 'internal server error' }));
  assert.equal(c.reason, 'session_mint_failed');
});

test('redactKeyFragments strips a masked-key fragment OpenAI commonly echoes back in a 401 message', () => {
  const scrubbed = redactKeyFragments('Incorrect API key provided: sk-proj-AbCd1234EfGh5678. You can find your API key at...');
  assert.ok(!scrubbed.includes('sk-proj-AbCd1234EfGh5678'));
  assert.match(scrubbed, /\[redacted\]/);
});

test('classifyError scrubs a key-shaped fragment out of the provider message it carries forward', () => {
  const c = classifyError(axiosError({ status: 401, message: 'Incorrect API key provided: sk-test-abc123XYZ789. Visit platform.openai.com.' }));
  assert.ok(!c.message.includes('sk-test-abc123XYZ789'), 'a masked/partial key fragment must never survive into the classified error');
});

test('classified error never carries the raw request/response body, only status/code/type/message', () => {
  const c = classifyError(axiosError({ status: 401, type: 'invalid_request_error', message: 'Incorrect API key provided: sk-abc***' }));
  const extraKeys = Object.keys(c).sort();
  assert.deepEqual(extraKeys, ['providerCode', 'providerStatus', 'providerType', 'reason'].sort());
  assert.equal(c.request, undefined, 'must never carry the raw axios request object');
  assert.equal(c.config, undefined, 'must never carry the raw axios config (headers, incl. Authorization) object');
});
