// Integration coverage for the annotations CRUD flow against a real DB —
// create, list (via /active), delete, and the validation 400s. Annotations
// are the mechanism the whole intelligence layer relies on to explain
// anomalies, so a break here is silent and wide-reaching.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');

const app = buildTestApp();
const MARKER = `test-annotation-${Date.now()}`;

after(async () => {
  await db.query(`DELETE FROM annotations WHERE label = $1`, [MARKER]);
  await closeDb();
});

test('POST /api/annotations rejects a body missing required fields', async () => {
  const res = await request(app).post('/api/annotations').set(authHeader()).send({ label: 'x' });
  assert.equal(res.status, 400);
});

test('POST /api/annotations creates a row, GET /api/annotations/active returns it, DELETE removes it', async () => {
  const now = new Date();
  const created = await request(app)
    .post('/api/annotations')
    .set(authHeader())
    .send({
      startTs: now.toISOString(),
      endTs: new Date(now.getTime() + 3600_000).toISOString(),
      category: 'brief_context',
      label: MARKER,
    });
  assert.equal(created.status, 200);
  assert.ok(created.body.id, 'response includes the new row id');

  const active = await request(app).get('/api/annotations/active').set(authHeader());
  assert.equal(active.status, 200);
  assert.ok(
    active.body.annotations.some((a) => a.label === MARKER),
    'the just-created annotation is active right now'
  );

  const deleted = await request(app).delete(`/api/annotations/${created.body.id}`).set(authHeader());
  assert.equal(deleted.status, 200);

  const afterDelete = await request(app).get('/api/annotations/active').set(authHeader());
  assert.ok(
    !afterDelete.body.annotations.some((a) => a.label === MARKER),
    'the deleted annotation no longer appears'
  );
});

test('DELETE /api/annotations/:id rejects an obviously-invalid id rather than querying the DB with it', async () => {
  const res = await request(app).delete('/api/annotations/x').set(authHeader());
  assert.equal(res.status, 400);
});
