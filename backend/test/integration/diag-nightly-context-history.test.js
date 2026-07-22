// GET /api/diag/nightly-context-history — the safe, admin-gated diagnostic
// for tracing the temporal-grounding fix. Exposes ONLY tag keys, temporal
// status, night-ending dates, ages, provenance, snapshot version, and a
// checkTemporalFraming verdict on an optional caller-supplied probe sentence
// — never generated Chief Brief prose, raw annotation text, or any other
// private content.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, ADMIN_TOKEN, closeDb } = require('./helpers');
const db = require('../../src/db');
const metricsStore = require('../../src/store/metrics');
const sourcesStore = require('../../src/store/sources');
const { naiveToUtcIso } = require('../../src/util/date');

const app = buildTestApp();
const TZ = process.env.TZ || 'America/New_York';

function localDayString(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 864e5);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

afterEach(async () => {
  await db.query(`DELETE FROM metrics WHERE domain = 'context' AND metric = 'late_meal' AND ts >= now() - interval '10 days'`);
});
after(async () => { await closeDb(); });

test('GET /api/diag/nightly-context-history requires the admin token, not just the general app token', async () => {
  const res = await request(app).get('/api/diag/nightly-context-history');
  assert.equal(res.status, 401);
});

test('reports dated tag history and never leaks generated prose', async () => {
  await sourcesStore.registerSource({ id: 'self_report', domain: 'health', displayName: 'Self-reported' }).catch(() => {});
  const dayStr = localDayString(2);
  await metricsStore.insertMetrics([
    { ts: new Date(naiveToUtcIso(`${dayStr}T12:00:00`, TZ)), domain: 'context', metric: 'late_meal', value: 1, unit: 'bool', source: 'self_report' },
  ]);

  const res = await request(app).get('/api/diag/nightly-context-history').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.snapshotVersion, 'number');
  assert.equal(res.body.tz, TZ);
  const tag = res.body.tags.find((t) => t.tag === 'late_meal');
  assert.ok(tag, 'expected the seeded late_meal tag to appear');
  assert.equal(tag.occurrences.length, 1);
  assert.equal(tag.occurrences[0].status, 'occurred');
  assert.equal(tag.occurrences[0].ageNights, 2);
  assert.equal(tag.occurrences[0].isCurrentOrFuturePlan, false);
  assert.equal(tag.occurrences[0].provenance, 'self_report');
  // No `summary` prose field, no raw text field of any kind.
  assert.equal(tag.summary, undefined);
});

test('the optional probe is validated but never echoed back in the response', async () => {
  const res = await request(app)
    .get('/api/diag/nightly-context-history')
    .query({ probe: 'The late-meal flag tonight can dent sleep quality.' })
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.probe.violated, true);
  assert.ok(res.body.probe.checks.includes('temporal_framing'));
  assert.equal(JSON.stringify(res.body).includes('late-meal flag tonight'), false, 'the probe sentence itself must never be echoed back');
});

test('a benign probe (advisory language) reports no violation', async () => {
  const res = await request(app)
    .get('/api/diag/nightly-context-history')
    .query({ probe: 'Avoid a late meal tonight.' })
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.probe.violated, false);
});

test('no probe supplied -> probe is null', async () => {
  const res = await request(app).get('/api/diag/nightly-context-history').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.probe, null);
});
