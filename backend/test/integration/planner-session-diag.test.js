// The planner-session diagnostic must answer "is a session published?" without
// ever becoming a way to read the session.
//
// sources.config->>'monarchToken' is a live Monarch credential. An endpoint
// that could return it would be the easiest possible way to leak it — into an
// HTTP response, a terminal scrollback, a log aggregator. So the contract is
// presence and length only, and it is worth a test precisely because the
// tempting "just add the value for debugging" change would look harmless.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, ADMIN_TOKEN, closeDb } = require('./helpers');
const db = require('../../src/db');

const app = buildTestApp();
const SECRET = `not-a-real-token-${Date.now()}-abcdefghijklmnop`;

after(async () => {
  await db.query(`DELETE FROM sources WHERE id = 'monarch_api' AND display_name = 'planner diag test'`);
  await closeDb();
});

test('the diagnostic is admin-gated', async () => {
  // The app token must not reach it — this row holds a credential.
  const res = await request(app).get('/api/diag/planner-session').set(authHeader());
  assert.equal(res.status, 401);
});

test('reports presence and length but NEVER the token itself', async () => {
  await db.query(
    `INSERT INTO sources (id, domain, display_name, config)
     VALUES ('monarch_api', 'wealth', 'planner diag test', $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, display_name = EXCLUDED.display_name`,
    [JSON.stringify({ monarchToken: SECRET, other: 'keep' })]
  );

  const res = await request(app).get('/api/diag/planner-session').set(authHeader(ADMIN_TOKEN));
  assert.equal(res.status, 200);
  assert.equal(res.body.hasMonarchToken, true);
  assert.equal(res.body.tokenLength, SECRET.length);
  assert.deepEqual(res.body.configKeys.sort(), ['monarchToken', 'other']);

  // The whole point: the value must not appear anywhere in the response.
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes(SECRET), 'the token leaked into the response');
  // Nor any substantial fragment of it.
  assert.ok(!body.includes(SECRET.slice(0, 12)), 'a token fragment leaked into the response');
});

test('an empty-string token reads as absent, not present', async () => {
  // The failure this exists to catch: a published-but-empty token looks fine
  // to a naive IS NOT NULL check while the planner still cannot authenticate.
  await db.query(
    `UPDATE sources SET config = $1::jsonb WHERE id = 'monarch_api'`,
    [JSON.stringify({ monarchToken: '' })]
  );
  const res = await request(app).get('/api/diag/planner-session').set(authHeader(ADMIN_TOKEN));
  assert.equal(res.body.hasMonarchToken, false);
  assert.equal(res.body.tokenLength, 0);
});

test('a row with no token at all reports absent rather than erroring', async () => {
  await db.query(`UPDATE sources SET config = '{}'::jsonb WHERE id = 'monarch_api'`);
  const res = await request(app).get('/api/diag/planner-session').set(authHeader(ADMIN_TOKEN));
  assert.equal(res.status, 200);
  assert.equal(res.body.hasMonarchToken, false);
  assert.deepEqual(res.body.configKeys, []);
});
