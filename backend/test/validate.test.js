// Shared request-validation helper (src/middleware/validate.js) — see the
// engineering review's #9.
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireFields } = require('../src/middleware/validate');

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

test('requireFields returns true and sends nothing when all fields are present', () => {
  const res = mockRes();
  const ok = requireFields({ a: 1, b: 'x' }, ['a', 'b'], res);
  assert.equal(ok, true);
  assert.equal(res.statusCode, null);
});

test('requireFields 400s naming a single missing field (singular "is required")', () => {
  const res = mockRes();
  const ok = requireFields({ a: 1 }, ['a', 'b'], res);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'b is required');
});

test('requireFields 400s naming multiple missing fields (plural "are required")', () => {
  const res = mockRes();
  const ok = requireFields({}, ['a', 'b'], res);
  assert.equal(ok, false);
  assert.equal(res.body.error, 'a, b are required');
});

test('requireFields treats empty string as missing', () => {
  const res = mockRes();
  const ok = requireFields({ a: '' }, ['a'], res);
  assert.equal(ok, false);
});

test('requireFields treats 0 and false as PRESENT, not missing', () => {
  const res = mockRes();
  const ok = requireFields({ a: 0, b: false }, ['a', 'b'], res);
  assert.equal(ok, true);
  assert.equal(res.statusCode, null);
});

test('requireFields handles a null/undefined source object without throwing', () => {
  const res = mockRes();
  assert.equal(requireFields(null, ['a'], res), false);
  assert.equal(res.body.error, 'a is required');
  const res2 = mockRes();
  assert.equal(requireFields(undefined, ['a'], res2), false);
});
