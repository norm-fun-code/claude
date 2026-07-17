// Integration coverage for audit fix 2: binding a pre-brief answer's
// effective window to the completed overnight sleep window is driven by
// SIGNAL SEMANTICS (signalKey === 'recovery_low'), not just wording — and the
// wording match itself now recognizes more natural variants. Driven through
// the real POST /briefing/context route against a real Postgres — see
// context-semantics.js's describesCompletedNight, routes/annotations.js, and
// intelligence/recovery-drivers.js.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const { localDateStr } = require('../../src/util/date');
const { computeRecoveryDrivers } = require('../../src/intelligence/recovery-drivers');

const app = buildTestApp();
const TZ = process.env.TZ || 'America/New_York';
const MARKER_PREFIX = 'recovery-night-binding-marker';

afterEach(async () => {
  await db.query(`DELETE FROM annotations WHERE label ILIKE $1`, [`%${MARKER_PREFIX}%`]);
  // The 'not-backdated' test below sends no signalKey, which routes/annotations.js
  // treats as ordinary day context (isDayContext) and also journals — leftover
  // rows here previously polluted metrics-daily-aggregate-tz.test.js's day
  // (unrelated day_journal reads by other suites scan by content, not source).
  await db.query(`DELETE FROM day_journal WHERE text ILIKE $1`, [`%${MARKER_PREFIX}%`]);
});
after(async () => { await closeDb(); });

async function postRecoveryLowAnswer(answer) {
  return request(app)
    .post('/api/briefing/context')
    .set(authHeader())
    .send({
      question: 'Your recovery score is 41 today — what do you think is really driving it?',
      answer,
      signalKey: 'recovery_low',
    });
}

function assertBoundToLastNight(row) {
  const now = new Date();
  const todayKey = localDateStr(TZ, now);
  const yesterdayKey = localDateStr(TZ, new Date(now.getTime() - 24 * 60 * 60 * 1000));
  assert.equal(localDateStr(TZ, row.start_ts), yesterdayKey, 'effective start must fall on the previous local evening');
  assert.equal(localDateStr(TZ, row.end_ts), todayKey, "effective end must fall on today's wake window");
  const endHourLocal = Number(new Date(row.end_ts).toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }));
  assert.ok(endHourLocal < 14, `effective end must be a morning wake time, got local hour ${endHourLocal}`);
  assert.equal(localDateStr(TZ, row.created_at), todayKey, 'created_at is the actual submission time, untouched by backdating');
}

test('recovery_low answer with NO date phrase at all still binds to last night (signal semantics, not wording)', async () => {
  const marker = `${MARKER_PREFIX} no-date-phrase ${Date.now()}`;
  const res = await postRecoveryLowAnswer(`${marker} — I had a drink and late meal`);
  assert.equal(res.status, 200);
  const { rows } = await db.query('SELECT start_ts, end_ts, created_at FROM annotations WHERE id = $1', [res.body.id]);
  assert.ok(rows[0], 'annotation must exist');
  assertBoundToLastNight(rows[0]);
});

test('recovery_low answer with a totally generic answer ("stressful week") still binds to last night', async () => {
  const marker = `${MARKER_PREFIX} generic ${Date.now()}`;
  const res = await postRecoveryLowAnswer(`${marker} stressful week`);
  assert.equal(res.status, 200);
  const { rows } = await db.query('SELECT start_ts, end_ts, created_at FROM annotations WHERE id = $1', [res.body.id]);
  assertBoundToLastNight(rows[0]);
});

for (const [label, phrase] of [
  ['last evening', 'went out for drinks last evening'],
  ['the night before', 'the night before was rough, barely slept'],
  ['previous night', 'ate a heavy meal the previous night'],
]) {
  test(`a manual-context answer phrased with "${label}" binds to last night via wording (no signalKey needed)`, async () => {
    const marker = `${MARKER_PREFIX} ${label.replace(/\s+/g, '-')} ${Date.now()}`;
    const res = await request(app)
      .post('/api/briefing/context')
      .set(authHeader())
      .send({ question: 'Anything to add?', answer: `${marker} ${phrase}` });
    assert.equal(res.status, 200);
    const { rows } = await db.query('SELECT start_ts, end_ts, created_at FROM annotations WHERE id = $1', [res.body.id]);
    assertBoundToLastNight(rows[0]);
  });
}

test('a recovery_low answer explains TODAY\'s recovery drivers but never the FOLLOWING night\'s or tomorrow\'s forecast', async () => {
  const marker = `${MARKER_PREFIX} today-only ${Date.now()}`;
  const res = await postRecoveryLowAnswer(`${marker} drank wine and had a late meal`);
  assert.equal(res.status, 200);

  const now = new Date();
  const todayDrivers = await computeRecoveryDrivers({ tz: TZ, now });
  assert.ok(todayDrivers.labels.some((l) => l.includes(marker)), 'must be an eligible driver for the morning it actually describes');

  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowDrivers = await computeRecoveryDrivers({ tz: TZ, now: tomorrow });
  assert.ok(!tomorrowDrivers.labels.some((l) => l.includes(marker)),
    'must NOT explain the following night\'s recovery reading — its effective window ended this morning');
});

test('a non-recovery, non-past-worded answer is NOT backdated (sanity: the fix is scoped, not a blanket always-bind)', async () => {
  const marker = `${MARKER_PREFIX} not-backdated ${Date.now()}`;
  const res = await request(app)
    .post('/api/briefing/context')
    .set(authHeader())
    .send({ question: 'Anything to flag?', answer: `${marker} quiet day, nothing notable` });
  assert.equal(res.status, 200);

  const now = new Date();
  const todayKey = localDateStr(TZ, now);
  const { rows } = await db.query('SELECT start_ts, created_at FROM annotations WHERE id = $1', [res.body.id]);
  assert.equal(localDateStr(TZ, rows[0].start_ts), todayKey, 'a genuinely forward-looking/generic note must stay "now", not backdated to last night');
});
