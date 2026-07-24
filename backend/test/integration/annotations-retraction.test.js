// Integration coverage for the retraction/context-relevance fix, exercised
// through the real HTTP routes + a real Postgres — see
// src/intelligence/context-semantics.js for the underlying rules and
// src/store/annotations.js for the retirement mechanism.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const annotationsStore = require('../../src/store/annotations');
const dayJournalStore = require('../../src/store/dayJournal');

const app = buildTestApp();
const TZ = process.env.TZ || 'America/New_York';

async function cleanupAnnotations(labelLike) {
  await db.query(`DELETE FROM annotations WHERE label ILIKE $1`, [`%${labelLike}%`]);
}

afterEach(async () => {
  await cleanupAnnotations('drinks with friends');
  await cleanupAnnotations('ambiguous-plan-marker');
  await cleanupAnnotations('quiet evening at home');
});
after(async () => { await closeDb(); });

test('POST /briefing/context: an explicit retraction is NOT copied into the day journal', async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });

  const res = await request(app)
    .post('/api/briefing/context')
    .set(authHeader())
    .send({
      question: 'Anything unusual last night?',
      answer: "I didnt end up going for drinks with friends tonight. Please forget that context.",
    });
  assert.equal(res.status, 200);

  const entries = await dayJournalStore.forDay(today);
  assert.ok(
    !entries.some((e) => e.text.toLowerCase().includes('forget that context')),
    'the retraction text must never reach the day journal'
  );
});

test('POST /briefing/context: a normal answer IS still copied into the day journal (no over-suppression)', async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const marker = `quiet evening at home ${Date.now()}`;

  // Deliberately not phrased around "last night"/"yesterday" — that would
  // backdate the journal entry to the previous day (see routes/
  // annotations.js's PAST_REFERRING_RE), which is correct behavior but not
  // what this test is checking.
  const res = await request(app)
    .post('/api/briefing/context')
    .set(authHeader())
    .send({ question: 'Anything you want to flag?', answer: marker });
  assert.equal(res.status, 200);

  const entries = await dayJournalStore.forDay(today);
  assert.ok(entries.some((e) => e.text === marker), 'a genuine answer must still be journaled');

  await db.query(`DELETE FROM day_journal WHERE text = $1`, [marker]);
});

test('POST /briefing/context: an unambiguous retraction retires the specific prior annotation it targets', async () => {
  const { id: planId } = await annotationsStore.createAnnotation({
    startTs: new Date().toISOString(),
    category: 'brief_context',
    label: 'Drinks with friends tonight',
  });

  // Deliberately NOT phrased around "last night" — see the store-layer fix
  // above: a retraction backdates its own start_ts when the QUESTION
  // references "last night"/"yesterday", which must not affect how far back
  // it searches for the plan it's retracting.
  const res = await request(app)
    .post('/api/briefing/context')
    .set(authHeader())
    .send({
      question: 'Anything you want to flag?',
      answer: "I didnt end up going for drinks with friends tonight. Please forget that context.",
    });
  assert.equal(res.status, 200);

  const { rows } = await db.query('SELECT retired_at FROM annotations WHERE id = $1', [planId]);
  assert.ok(rows[0]?.retired_at, 'the specific plan the retraction names should be retired');

  await db.query('DELETE FROM annotations WHERE id = $1', [planId]);
});

test('retired context is excluded from GET /annotations/active and from overlapping() directly', async () => {
  const marker = `ambiguous-plan-marker ${Date.now()}`;
  const { id } = await annotationsStore.createAnnotation({
    startTs: new Date().toISOString(),
    category: 'brief_context',
    label: marker,
  });

  let active = await request(app).get('/api/annotations/active').set(authHeader());
  assert.ok(active.body.annotations.some((a) => a.id === id), 'sanity: the annotation is active before retirement');

  const retired = await annotationsStore.retireAnnotation(id, 'test retirement');
  assert.equal(retired, true);

  active = await request(app).get('/api/annotations/active').set(authHeader());
  assert.ok(!active.body.annotations.some((a) => a.id === id), 'a retired annotation must not appear in /annotations/active');

  const overlapping = await annotationsStore.overlapping(new Date(Date.now() - 3600_000), new Date());
  assert.ok(!overlapping.some((a) => a.id === id), 'a retired annotation must not appear in overlapping() either');

  await db.query('DELETE FROM annotations WHERE id = $1', [id]);
});

test('retireAnnotation is idempotent — retiring an already-retired row is a no-op, not an error', async () => {
  const { id } = await annotationsStore.createAnnotation({
    startTs: new Date().toISOString(),
    category: 'brief_context',
    label: `ambiguous-plan-marker idempotent ${Date.now()}`,
  });
  const first = await annotationsStore.retireAnnotation(id, 'first');
  const second = await annotationsStore.retireAnnotation(id, 'second');
  assert.equal(first, true);
  assert.equal(second, false, 'the second retirement should be a no-op');

  const { rows } = await db.query('SELECT retired_reason FROM annotations WHERE id = $1', [id]);
  assert.equal(rows[0].retired_reason, 'first', 'the original reason is preserved, not overwritten');

  await db.query('DELETE FROM annotations WHERE id = $1', [id]);
});

test('createAnnotation returns {id, eventKind, retiredAnnotationId} and classifies a retraction correctly', async () => {
  const { id, eventKind, retiredAnnotationId } = await annotationsStore.createAnnotation({
    startTs: new Date().toISOString(),
    category: 'brief_context',
    label: 'Please forget that context, ambiguous-plan-marker unrelated',
  });
  assert.ok(id);
  assert.equal(eventKind, 'retraction');
  // No specific unambiguous prior annotation exists to retire in this test's
  // isolated run — the important guarantee is that it doesn't throw or guess.
  assert.equal(retiredAnnotationId, null);

  await db.query('DELETE FROM annotations WHERE id = $1', [id]);
});

// Requirement: already-persisted contaminated findings (built by the OLD
// unconditional annotation-attachment logic, before this fix) must disappear
// on deploy, not linger until the next scheduled analyze() run. Migration
// 046_annotation_retirement.sql does this with a one-time
// `UPDATE findings SET status='superseded' WHERE status='open' AND detail
// LIKE '%may explain this deviation%'`. This proves that exact statement
// correctly targets a contaminated finding and leaves an unrelated one alone.
test('the migration\'s contaminated-finding cleanup query supersedes old "may explain this deviation" findings, and only those', async () => {
  const { rows: [contaminated] } = await db.query(
    `INSERT INTO findings (type, domains, title, detail, status, evidence)
     VALUES ('anomaly', '{health}', 'Resting HR well above your usual',
       'Resting HR is 60.2 today vs your baseline of 54.1. (Context: I didnt end up going for drinks with friends tonight. Please forget that context. (2 days ago) — may explain this deviation.)',
       'open', '{"auto":true,"kind":"anomaly","metric":"health:resting_hr"}')
     RETURNING id`
  );
  const { rows: [clean] } = await db.query(
    `INSERT INTO findings (type, domains, title, detail, status, evidence)
     VALUES ('anomaly', '{health}', 'Steps well below your usual',
       'Steps are 1200 today vs your baseline of 8000.',
       'open', '{"auto":true,"kind":"anomaly","metric":"health:steps"}')
     RETURNING id`
  );

  await db.query(
    `UPDATE findings SET status = 'superseded' WHERE status = 'open' AND detail LIKE '%may explain this deviation%'`
  );

  const { rows: after_ } = await db.query('SELECT id, status FROM findings WHERE id = ANY($1)', [[contaminated.id, clean.id]]);
  const byId = Object.fromEntries(after_.map((r) => [r.id, r.status]));
  assert.equal(byId[contaminated.id], 'superseded', 'the contaminated finding must be superseded');
  assert.equal(byId[clean.id], 'open', 'an unrelated finding must be left untouched');

  await db.query('DELETE FROM findings WHERE id = ANY($1)', [[contaminated.id, clean.id]]);
});

test('createAnnotation does not retire an unrelated annotation when the retraction has no clear match', async () => {
  const unrelatedMarker = `ambiguous-plan-marker unrelated topic ${Date.now()}`;
  const { id: unrelatedId } = await annotationsStore.createAnnotation({
    startTs: new Date().toISOString(),
    category: 'illness',
    label: unrelatedMarker,
  });

  const { id: retractionId, retiredAnnotationId } = await annotationsStore.createAnnotation({
    startTs: new Date().toISOString(),
    category: 'brief_context',
    label: 'Never mind, forget what I said about the movie plans',
  });

  assert.notEqual(retiredAnnotationId, unrelatedId, 'an unrelated annotation must never be silently retired');
  const { rows } = await db.query('SELECT retired_at FROM annotations WHERE id = $1', [unrelatedId]);
  assert.equal(rows[0].retired_at, null);

  // The retraction annotation itself defaults to a multi-day end_ts (see
  // createAnnotation's endOfTomorrowET fallback) — left uncleaned, it stays
  // "currently active" for up to two real days and pollutes any later
  // test/suite run that reads current annotations (e.g. predict.js's
  // forecast context).
  await db.query('DELETE FROM annotations WHERE id = ANY($1)', [[unrelatedId, retractionId]]);
});
