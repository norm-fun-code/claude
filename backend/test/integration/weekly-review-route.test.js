// Weekly-review CTA fix — required regression coverage against REAL
// Postgres for GET /api/briefing/weekly-review, the server-side counterpart
// of the mobile canonical openWeeklyReview action. Proves: exact retrieval
// by stable id (never by title text or array position), exact retrieval by
// weekStart when id isn't known, 404 on a genuine miss (never substituting
// a different review or triggering regeneration), and 400 when neither
// identifier is given.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const briefingsStore = require('../../src/store/briefings');
const db = require('../../src/db');

const app = buildTestApp();
const TEST_MARKER = `weekly-review-route-${Date.now()}`;

after(async () => {
  await db.query(`DELETE FROM briefings WHERE content->>'headline' LIKE $1`, [`${TEST_MARKER}%`]);
  await closeDb();
});

function reviewContent(suffix) {
  return {
    headline: `${TEST_MARKER}-${suffix}`,
    narrative: `Narrative for ${suffix}.`,
    wins: [], watchouts: [], focus: [],
  };
}

test('required: GET /briefing/weekly-review?id= returns the EXACT row by stable id, never by title/position', async (t) => {
  const contentA = reviewContent('by-id-A');
  const contentB = reviewContent('by-id-B');
  const savedA = await briefingsStore.saveBriefing({ kind: 'weekly', content: contentA, periodStart: '2026-07-06', periodEnd: '2026-07-12' });
  const savedB = await briefingsStore.saveBriefing({ kind: 'weekly', content: contentB, periodStart: '2026-07-13', periodEnd: '2026-07-19' });

  const res = await request(app).get(`/api/briefing/weekly-review?id=${savedA.id}`).set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(res.body.headline, contentA.headline);
  assert.equal(res.body.id, savedA.id);
  assert.equal(res.body.weekStart, '2026-07-06');
  assert.notEqual(res.body.headline, contentB.headline);
});

test('required: GET /briefing/weekly-review?weekStart= returns the exact review for that week when id is unknown', async (t) => {
  const content = reviewContent('by-week');
  await briefingsStore.saveBriefing({ kind: 'weekly', content, periodStart: '2026-06-01', periodEnd: '2026-06-07' });

  const res = await request(app).get('/api/briefing/weekly-review?weekStart=2026-06-01').set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(res.body.headline, content.headline);
});

test('required: a genuine miss 404s — never substitutes a different review, never triggers regeneration', async (t) => {
  let regenerated = false;
  const review = require('../../src/intelligence/review');
  const origRunReview = review.runReview;
  review.runReview = async (...args) => { regenerated = true; return origRunReview(...args); };
  try {
    const res = await request(app).get('/api/briefing/weekly-review?id=999999999').set(authHeader());
    assert.equal(res.status, 404);
    assert.equal(regenerated, false, 'a miss must never trigger review generation');
  } finally {
    review.runReview = origRunReview;
  }
});

test('required: neither id nor weekStart given returns 400, not a silent/degraded 200', async (t) => {
  const res = await request(app).get('/api/briefing/weekly-review').set(authHeader());
  assert.equal(res.status, 400);
});

test('required: a daily (non-weekly) briefing row sharing a coincidental id is never returned as a weekly review', async (t) => {
  const dailyContent = { snapshotId: `${TEST_MARKER}-daily`, chiefBrief: { synthesis: 'x' } };
  const savedDaily = await briefingsStore.saveBriefing({ kind: 'daily', content: dailyContent });

  const res = await request(app).get(`/api/briefing/weekly-review?id=${savedDaily.id}`).set(authHeader());
  assert.equal(res.status, 404);
});
