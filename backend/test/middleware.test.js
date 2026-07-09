// Foundation for the server.js decomposition (see review discussion):
// asyncHandler + errorHandler replace the 135 identical
// `try { ... } catch (err) { res.status(500).json({ error: err.message }) }`
// blocks duplicated across server.js's 146 routes with one wrapper + one
// central handler. These tests verify the replacement is behavior-preserving
// before any real route is converted to use it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { asyncHandler } = require('../src/middleware/asyncHandler');
const { errorHandler } = require('../src/middleware/errorHandler');

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

test('asyncHandler: a resolving handler runs normally and never calls next', async () => {
  let ran = false;
  const handler = asyncHandler(async (req, res) => { ran = true; res.json({ ok: true }); });
  const res = mockRes();
  let nextCalled = false;
  await handler({}, res, () => { nextCalled = true; });
  // asyncHandler doesn't await internally (fire-and-forget catch) — wait a tick
  await new Promise((r) => setImmediate(r));
  assert.equal(ran, true);
  assert.equal(nextCalled, false);
  assert.deepEqual(res.body, { ok: true });
});

test('asyncHandler: a rejecting handler forwards the error to next(err), not a thrown/unhandled rejection', async () => {
  const boom = new Error('db exploded');
  const handler = asyncHandler(async () => { throw boom; });
  const res = mockRes();
  let caught = null;
  handler({}, res, (err) => { caught = err; });
  await new Promise((r) => setImmediate(r));
  assert.equal(caught, boom);
  assert.equal(res.body, null, 'next(err) was called instead of the handler responding itself');
});

test('asyncHandler: a handler that rejects with a non-Error value still reaches next', async () => {
  const handler = asyncHandler(async () => { throw 'plain string rejection'; });
  const res = mockRes();
  let caught;
  let called = false;
  handler({}, res, (err) => { caught = err; called = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(called, true);
  assert.equal(caught, 'plain string rejection');
});

test('errorHandler: matches the exact shape of the 135 duplicated try/catch blocks it replaces', () => {
  const err = new Error('something failed');
  const req = { method: 'GET', originalUrl: '/api/whatever' };
  const res = mockRes();
  const origConsoleError = console.error;
  let logged = null;
  console.error = (...args) => { logged = args; };
  try {
    errorHandler(err, req, res, () => {});
  } finally {
    console.error = origConsoleError;
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'something failed' });
  assert.ok(logged, 'errorHandler should log before responding');
});

test('errorHandler: honors a custom err.status when a caller sets one, defaults to 500 otherwise', () => {
  const req = { method: 'POST', originalUrl: '/api/x' };
  console.error = () => {}; // silence for this test

  const notFound = new Error('missing');
  notFound.status = 404;
  const res1 = mockRes();
  errorHandler(notFound, req, res1, () => {});
  assert.equal(res1.statusCode, 404);

  const plain = new Error('unspecified failure');
  const res2 = mockRes();
  errorHandler(plain, req, res2, () => {});
  assert.equal(res2.statusCode, 500);
});

test('errorHandler: defers to next(err) instead of double-responding once headers are already sent', () => {
  const req = { method: 'GET', originalUrl: '/api/streamy' };
  console.error = () => {};
  const res = mockRes();
  res.headersSent = true;
  let deferred = null;
  errorHandler(new Error('too late'), req, res, (err) => { deferred = err; });
  assert.equal(res.body, null, 'must not attempt res.json() after headers are sent');
  assert.ok(deferred);
});
