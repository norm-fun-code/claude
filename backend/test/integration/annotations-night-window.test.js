// Integration coverage for Bug 2 (bind annotation context to the night it
// describes) and Bug 1's durable calendar_load signal-answer ledger, driven
// through the real POST /briefing/context route against a real Postgres —
// see routes/annotations.js, intelligence/analyze.js's resolveNightWindow,
// intelligence/recovery-drivers.js, and store/signalAnswers.js.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const { localDateStr } = require('../../src/util/date');
const { computeRecoveryDrivers } = require('../../src/intelligence/recovery-drivers');
const signalAnswersStore = require('../../src/store/signalAnswers');

const app = buildTestApp();
const TZ = process.env.TZ || 'America/New_York';

async function cleanupAnnotations(labelLike) {
  await db.query(`DELETE FROM annotations WHERE label ILIKE $1`, [`%${labelLike}%`]);
}

afterEach(async () => {
  await cleanupAnnotations('overnight-window-marker');
  await db.query(`DELETE FROM signal_answers WHERE subject_key = 'calendar_load' AND fingerprint LIKE 'test-%'`);
});
after(async () => { await closeDb(); });

test('"last night" appearing only in the ANSWER (not the question) still binds the effective window to last night', async () => {
  const marker = `overnight-window-marker ${Date.now()}`;
  const res = await request(app)
    .post('/api/briefing/context')
    .set(authHeader())
    .send({
      question: 'Anything you want to flag?', // no past-reference wording
      answer: `${marker} — drank wine last night`,
    });
  assert.equal(res.status, 200);

  const { rows } = await db.query('SELECT start_ts, end_ts, created_at FROM annotations WHERE id = $1', [res.body.id]);
  const row = rows[0];
  assert.ok(row, 'the annotation must have been created');

  const now = new Date();
  const todayKey = localDateStr(TZ, now);
  const yesterdayKey = localDateStr(TZ, new Date(now.getTime() - 24 * 60 * 60 * 1000));

  assert.equal(localDateStr(TZ, row.start_ts), yesterdayKey,
    'effective start must fall on the PREVIOUS local evening, not today');
  assert.equal(localDateStr(TZ, row.end_ts), todayKey,
    'effective end must fall on TODAY (this morning\'s wake window), not tomorrow');
  // The bug: end_ts used to default to end-of-TOMORROW (23:59:59 the day
  // after). Assert the actual fix directly — end_ts is nowhere near midnight.
  const endHourLocal = Number(new Date(row.end_ts).toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }));
  assert.ok(endHourLocal < 14, `effective end (${row.end_ts}) must be a morning wake time, not end-of-day — got local hour ${endHourLocal}`);
  // created_at (the DB's own audit timestamp) stays "now" — separate from
  // the effective start/end, which moved to describe the night in question.
  assert.equal(localDateStr(TZ, row.created_at), todayKey, 'created_at is untouched by the effective-window backdating');
});

test('the day-journal entry for a last-night-only-in-answer note is filed under yesterday\'s date', async () => {
  const marker = `overnight-window-marker journal ${Date.now()}`;
  const dayJournalStore = require('../../src/store/dayJournal');
  const res = await request(app)
    .post('/api/briefing/context')
    .set(authHeader())
    .send({ question: 'Anything to flag?', answer: `${marker} overnight guest, house was noisy` });
  assert.equal(res.status, 200);

  const now = new Date();
  const yesterdayKey = localDateStr(TZ, new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const todayKey = localDateStr(TZ, now);

  const [yestEntries, todayEntries] = await Promise.all([
    dayJournalStore.forDay(yesterdayKey),
    dayJournalStore.forDay(todayKey),
  ]);
  assert.ok(yestEntries.some((e) => e.text.includes(marker)), 'a last-night answer must be journaled under YESTERDAY\'s date');
  assert.ok(!todayEntries.some((e) => e.text.includes(marker)), 'it must not also appear under today');

  await db.query(`DELETE FROM day_journal WHERE text LIKE $1`, [`%${marker}%`]);
});

test('a genuine "last night" annotation explains TODAY\'s recovery drivers but not the FOLLOWING night\'s', async () => {
  const marker = `overnight-window-marker recovery ${Date.now()}`;
  const res = await request(app)
    .post('/api/briefing/context')
    .set(authHeader())
    .send({ question: 'What happened?', answer: `${marker} drank wine last night, poor sleep` });
  assert.equal(res.status, 200);

  const now = new Date();
  const todayDrivers = await computeRecoveryDrivers({ tz: TZ, now });
  assert.ok(
    todayDrivers.labels.some((l) => l.includes(marker)),
    'the annotation must be an eligible recovery driver for the morning it actually describes'
  );

  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowDrivers = await computeRecoveryDrivers({ tz: TZ, now: tomorrow });
  assert.ok(
    !tomorrowDrivers.labels.some((l) => l.includes(marker)),
    'the SAME annotation must NOT explain the following night\'s recovery reading — its effective window ended this morning'
  );
});

test('general (non-health) context can never become a recovery driver, even when phrased around last night', async () => {
  const marker = `overnight-window-marker general ${Date.now()}`;
  // A scheduling/logistics note, not a plausible health cause — the same
  // "last night" temporal binding applies, but topical plausibility (Bug 2's
  // OTHER half of isEligibleContext) must still gate it out.
  const res = await request(app)
    .post('/api/briefing/context')
    .set(authHeader())
    .send({ question: 'Anything happen?', answer: `${marker} finished the deck last night for tomorrow's meeting` });
  assert.equal(res.status, 200);

  const drivers = await computeRecoveryDrivers({ tz: TZ, now: new Date() });
  assert.ok(!drivers.labels.some((l) => l.includes(marker)),
    'a logistics note is not a plausible health cause, regardless of its temporal binding');
});

test('POST /briefing/context with a calendar_load signalKey persists a durable, server-side answer BEFORE the response returns', async () => {
  const today = localDateStr(TZ, new Date());
  const signalKey = `calendar_load:${today}`;
  const res = await request(app)
    .post('/api/briefing/context')
    .set(authHeader())
    .send({ question: 'You have 5.0h of meetings today', answer: 'Sprint planning ran long', signalKey, fingerprint: 'test-5.00' });
  assert.equal(res.status, 200);

  // NO polling — recordAnswer is now awaited inside the route (see
  // routes/annotations.js) before it responds, so the durable answer must be
  // immediately readable the instant this request resolves, not "eventually."
  const map = await signalAnswersStore.answersFor('calendar_load', { fromDate: today, toDate: today });
  const stored = map.get(today);
  assert.ok(stored, 'the calendar_load answer must be durably recorded server-side by the time the response returns');
  assert.equal(stored.fingerprint, 'test-5.00');
  assert.equal(stored.answer, 'Sprint planning ran long');
});

test('a signal-answer write failure surfaces as an error response, not a false {ok:true}', async () => {
  // Force recordAnswer to reject, simulating a DB hiccup on the durable write.
  const original = signalAnswersStore.recordAnswer;
  signalAnswersStore.recordAnswer = async () => { throw new Error('simulated write failure'); };
  try {
    const today = localDateStr(TZ, new Date());
    const res = await request(app)
      .post('/api/briefing/context')
      .set(authHeader())
      .send({ question: 'You have 5.0h of meetings today', answer: 'should not be saved', signalKey: `calendar_load:${today}`, fingerprint: 'test-fail' });
    assert.notEqual(res.status, 200, 'a failed durable write must not report success');
    // And no partial state: the annotation must not have been created either
    // (recordAnswer is awaited BEFORE createAnnotation runs).
    const { rows } = await db.query(`SELECT id FROM annotations WHERE label = $1`, ['should not be saved']);
    assert.equal(rows.length, 0, 'no annotation should be created when the durable answer write fails first');
  } finally {
    signalAnswersStore.recordAnswer = original;
  }
});
