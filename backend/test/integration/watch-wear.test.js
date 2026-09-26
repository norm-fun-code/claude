// "I didn't wear my Apple Watch today."
//
// The failure this prevents: a wrist-sensed metric does not go SILENT when the
// watch is off, it reads near-ZERO — so "barely moved" and "on the charger" are
// indistinguishable in the spine, and an unworn day quietly drags down step
// trends, registers as an activity anomaly, and poisons any baseline computed
// over it.
//
// What matters here, and what a unit test cannot show: the exclusion is applied
// inside store/metrics.js's daily-read funnels, so it reaches every consumer at
// once. These tests read through those real functions against a real database.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const metricsStore = require('../../src/store/metrics');
const watchWear = require('../../src/store/watchWear');

const app = buildTestApp();
const TZ = 'America/New_York';
const TAG = `watch-wear-${Date.now()}`;
const WORN_DAY = '2025-03-11';
const OFF_DAY = '2025-03-12';
const tsFor = (day) => `${day}T16:00:00.000Z`; // midday ET — lands on its own local day

after(async () => {
  await db.query(`DELETE FROM metrics WHERE metadata->>'testTag' = $1`, [TAG]);
  await db.query(`DELETE FROM watch_off_days WHERE local_day IN ($1, $2)`, [WORN_DAY, OFF_DAY]);
  await closeDb();
});

test('a day is worn until it is explicitly marked otherwise', async () => {
  assert.equal(await watchWear.wasWorn(OFF_DAY), true, 'wearing it is the default');
  const res = await request(app).get('/api/watch-wear').query({ day: OFF_DAY })
    .set(authHeader()).set('X-Time-Zone', TZ);
  assert.equal(res.status, 200);
  assert.equal(res.body.worn, true);
  assert.equal(res.body.day, OFF_DAY);
});

test('POST validates that worn is an actual boolean', async () => {
  for (const body of [{ day: OFF_DAY }, { day: OFF_DAY, worn: 'no' }, { day: OFF_DAY, worn: 0 }]) {
    const res = await request(app).post('/api/watch-wear').set(authHeader()).send(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('marking a day not-worn removes its watch readings from the daily read — and only that day', async () => {
  // metrics.source is a FK into `sources`, so the REAL source ids have to
  // exist — the test writes as the watch and as the activity estimator,
  // exactly like production. Rows are tagged in metadata and cleaned up by
  // that tag, so nothing real is touched.
  const sourcesStore = require('../../src/store/sources');
  await sourcesStore.registerSource({ id: 'apple_health', domain: 'health', displayName: 'Apple Watch' });
  await sourcesStore.registerSource({ id: 'activity_est', domain: 'health', displayName: 'Activity estimate' });
  const meta = { testTag: TAG };
  // Two days of real watch steps. The off day reads near-zero, exactly as an
  // unworn watch does — the case that used to be indistinguishable from a
  // genuinely sedentary day.
  await metricsStore.insertMetrics([
    { ts: tsFor(WORN_DAY), domain: 'health', metric: 'steps', value: 9000, source: 'apple_health', metadata: meta },
    { ts: tsFor(OFF_DAY), domain: 'health', metric: 'steps', value: 40, source: 'apple_health', metadata: meta },
  ]);

  const read = () => metricsStore.dailyAggregate({
    domain: 'health', metric: 'steps', from: new Date(`${WORN_DAY}T00:00:00Z`),
    to: new Date(`${OFF_DAY}T23:59:59Z`), agg: 'max', tz: TZ,
  });

  const before = await read();
  assert.equal(before.length, 2, 'both days present while the watch counts as worn');

  const marked = await request(app).post('/api/watch-wear').set(authHeader())
    .send({ day: OFF_DAY, worn: false });
  assert.equal(marked.status, 200);

  const after1 = await read();
  assert.equal(after1.length, 1, 'the unworn day must drop out of the daily read');
  assert.equal(String(after1[0].day).slice(0, 10) === WORN_DAY || new Date(after1[0].day).getDate() === 11, true);
  assert.equal(Number(after1[0].value), 9000, 'the worn day is untouched');
});

test('toggling back restores the day — nothing was deleted', async () => {
  const res = await request(app).post('/api/watch-wear').set(authHeader())
    .send({ day: OFF_DAY, worn: true });
  assert.equal(res.status, 200);

  const rows = await metricsStore.dailyAggregate({
    domain: 'health', metric: 'steps', from: new Date(`${WORN_DAY}T00:00:00Z`),
    to: new Date(`${OFF_DAY}T23:59:59Z`), agg: 'max', tz: TZ,
  });
  assert.equal(rows.length, 2, 'the reading was gated, never destroyed');
});

test('a deliberately logged off-watch activity still counts on an unworn day', async () => {
  // The combination that keeps the day honest: the watch's own near-zero
  // reading is dropped, but the estimate written for an activity the watch
  // never saw (activity-sync.js's 'activity_est') survives. Without this, a
  // no-watch basketball session would vanish along with the watch data.
  await metricsStore.insertMetrics([
    { ts: tsFor(OFF_DAY), domain: 'health', metric: 'steps', value: 9100, source: 'activity_est', metadata: { testTag: TAG } },
  ]);
  await request(app).post('/api/watch-wear').set(authHeader()).send({ day: OFF_DAY, worn: false });

  const rows = await metricsStore.dailyAggregate({
    domain: 'health', metric: 'steps', from: new Date(`${OFF_DAY}T00:00:00Z`),
    to: new Date(`${OFF_DAY}T23:59:59Z`), agg: 'max', tz: TZ,
  });
  assert.equal(rows.length, 1, 'the logged activity keeps the day in the series');
  assert.equal(Number(rows[0].value), 9100, 'and it is the estimate that survives, not the watch');
});

test('a metric that does not depend on the wrist is never excluded', async () => {
  // Weight comes from a scale. Marking the watch off must not erase it, or the
  // toggle would quietly delete unrelated data from every trend.
  await metricsStore.insertMetrics([
    { ts: tsFor(OFF_DAY), domain: 'health', metric: 'weight', value: 180, source: 'apple_health', metadata: { testTag: TAG } },
  ]);
  const rows = await metricsStore.dailyAggregate({
    domain: 'health', metric: 'weight', from: new Date(`${OFF_DAY}T00:00:00Z`),
    to: new Date(`${OFF_DAY}T23:59:59Z`), agg: 'avg', tz: TZ,
  });
  assert.equal(rows.length, 1, 'weight survives an unworn day');
  assert.equal(Number(rows[0].value), 180);
});

test('the source-priority read funnel is gated too', async () => {
  // dailyAggregatePreferSource is the other daily-read path (recovery,
  // precedent, analyze). Leaving it ungated would let an unworn day back in
  // through the side door.
  const rows = await metricsStore.dailyAggregatePreferSource({
    domain: 'health', metric: 'active_energy', from: new Date(`${OFF_DAY}T00:00:00Z`),
    to: new Date(`${OFF_DAY}T23:59:59Z`), agg: 'sum', tz: TZ,
  });
  await metricsStore.insertMetrics([
    { ts: tsFor(OFF_DAY), domain: 'health', metric: 'active_energy', value: 30, source: 'apple_health', metadata: { testTag: TAG } },
  ]);
  const after1 = await metricsStore.dailyAggregatePreferSource({
    domain: 'health', metric: 'active_energy', from: new Date(`${OFF_DAY}T00:00:00Z`),
    to: new Date(`${OFF_DAY}T23:59:59Z`), agg: 'sum', tz: TZ,
  });
  assert.equal(after1.length, rows.length, 'an unworn day adds nothing through the preferSource funnel');
});

test('the recent-exceptions list reports what was marked', async () => {
  const res = await request(app).get('/api/watch-wear/recent').set(authHeader());
  assert.equal(res.status, 200);
  assert.ok(res.body.notWorn.some((d) => d.day === OFF_DAY), 'the marked day must be listed');
});

test('the endpoint requires auth', async () => {
  assert.equal((await request(app).get('/api/watch-wear')).status, 401);
});
