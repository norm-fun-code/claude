// Precedent route against a REAL database — the whole path, not the pure
// core (test/precedent.test.js already owns the gates).
//
// What this proves that a unit test cannot: that the SQL the engine leans on
// (dailyAggregatePreferSource's per-local-day, source-priority resolution)
// actually feeds the z-scoring the way the engine assumes, that a real
// 180-day scan returns inside a request, and that the "not enough evidence"
// answer is a normal 200 rather than an error or a crash.
//
// Seeds a synthetic but REALISTIC history under a dedicated source name, then
// removes exactly those rows again — it never touches real ingested data.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');

const app = buildTestApp();
// HRV and resting HR MUST be seeded under a night source: the engine reads
// them through intelligence/recovery.js's RECOVERY_SOURCE_LOCK, exactly as
// production does, so a test that seeded them under an arbitrary source would
// be exercising a path production never takes. Rows are tagged in metadata and
// removed by that tag, so cleanup can never touch a real reading.
const NIGHT_SOURCE = 'eight_sleep';
const SOURCE = `test-precedent-${Date.now()}`;
const TAG = SOURCE;
const TZ = 'America/New_York';
// A fixed "today" so the seeded history is deterministic rather than relative
// to whenever CI happens to run.
const TODAY = '2026-09-08';

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Midday local — safely inside the local calendar day in ET regardless of
 *  DST, so the row buckets onto the day it is meant to. */
function tsFor(day) {
  return `${day}T16:00:00.000Z`;
}

after(async () => {
  await db.query(`DELETE FROM metrics WHERE metadata->>'testTag' = $1`, [TAG]);
  await db.query(`DELETE FROM sources WHERE id = $1`, [SOURCE]);
  await closeDb();
});

test('GET /api/precedent requires auth', async () => {
  const res = await request(app).get('/api/precedent');
  assert.equal(res.status, 401);
});

test('GET /api/precedent answers 200 with a null precedent when the spine cannot support one', async () => {
  // Nothing seeded yet for this far-past day, so no feature can clear its
  // baseline gate. "No evidence" is a normal answer, never an error.
  const res = await request(app)
    .get('/api/precedent')
    .query({ day: '2019-04-04', fresh: '1' })
    .set(authHeader())
    .set('X-Time-Zone', TZ);
  assert.equal(res.status, 200);
  assert.equal(res.body.precedent, null);
  assert.equal(res.body.asOf, '2019-04-04');
});

test('GET /api/precedent rejects nothing but silently ignores a malformed day', async () => {
  // A bad ?day= must not 500 or be interpolated anywhere — it falls back to
  // the real local day.
  const res = await request(app)
    .get('/api/precedent')
    .query({ day: "2026-01-01'; DROP TABLE metrics; --", fresh: '1' })
    .set(authHeader())
    .set('X-Time-Zone', TZ);
  assert.equal(res.status, 200);
  assert.match(res.body.asOf, /^\d{4}-\d{2}-\d{2}$/);
  const { rows } = await db.query(`SELECT to_regclass('public.metrics') AS t`);
  assert.ok(rows[0].t, 'the metrics table must still exist');
});

test('GET /api/precedent finds real precedents in a seeded history and reports checkable dates', async () => {
  // 150 days of history. Baseline days alternate around a personal norm; a
  // recurring "rough morning" (low HRV, high resting HR, short sleep) is
  // planted every 10th day, and TODAY is one of them — so those days, and
  // essentially only those days, should come back as precedents.
  const metricsStore = require('../../src/store/metrics');
  const sourcesStore = require('../../src/store/sources');
  // metrics.source is a foreign key into `sources` — both sources have to
  // exist before their rows can, exactly like a real connector. registerSource
  // is an upsert, so re-declaring the night source is harmless.
  await sourcesStore.registerSource({ id: SOURCE, domain: 'health', displayName: 'Precedent route test' });
  await sourcesStore.registerSource({ id: NIGHT_SOURCE, domain: 'health', displayName: 'Eight Sleep' });
  const rows = [];
  const rough = new Set();
  for (let i = 150; i >= 0; i--) {
    const day = addDays(TODAY, -i);
    const isRough = i % 10 === 0;
    if (isRough && i > 1) rough.add(day);
    // Small deterministic wobble so the baseline has genuine spread (a
    // constant series is correctly refused by causalZScores).
    const w = ((i * 7) % 5) * 0.4;
    const hrv = isRough ? 38 + w * 0.2 : 62 + w;
    const rhr = isRough ? 60 - w * 0.1 : 51 + w * 0.2;
    const sleep = isRough ? 5.6 + w * 0.05 : 7.5 + w * 0.1;
    // Load alternates between genuinely light and genuinely hard days so the
    // lever has real variance to split on.
    const active = i % 2 === 0 ? 180 + w * 5 : 900 + w * 10;
    const meta = { testTag: TAG };
    rows.push(
      { ts: tsFor(day), domain: 'health', metric: 'hrv', value: hrv, source: NIGHT_SOURCE, metadata: meta },
      { ts: tsFor(day), domain: 'health', metric: 'resting_hr', value: rhr, source: NIGHT_SOURCE, metadata: meta },
      { ts: tsFor(day), domain: 'health', metric: 'sleep_hours', value: sleep, source: SOURCE, metadata: meta },
      { ts: tsFor(day), domain: 'health', metric: 'active_energy', value: active, source: SOURCE, metadata: meta }
    );
  }
  await metricsStore.insertMetrics(rows);

  const res = await request(app)
    .get('/api/precedent')
    .query({ day: TODAY, days: '160', fresh: '1' })
    .set(authHeader())
    .set('X-Time-Zone', TZ);

  assert.equal(res.status, 200);
  const p = res.body.precedent;
  assert.ok(p, 'a planted, repeatedly-recurring morning pattern must be found');
  assert.ok(p.count >= 5, `expected at least 5 precedents, got ${p.count}`);

  // Every precedent is a real, past, checkable calendar date.
  for (const item of p.precedents) {
    assert.match(item.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(item.day < TODAY, `precedent ${item.day} is not in the past`);
    assert.ok(item.similarity >= 80, `precedent ${item.day} scored below the gate`);
  }

  // The retrieved days must actually BE the planted rough mornings — a
  // precedent set full of ordinary days would mean the similarity search is
  // matching noise.
  const matched = p.precedents.filter((item) => rough.has(item.day)).length;
  assert.ok(
    matched >= Math.ceil(p.precedents.length * 0.8),
    `only ${matched}/${p.precedents.length} retrieved days were the planted pattern`
  );

  // The state description must name the metrics that actually made the day
  // unusual, with their observed values attached.
  assert.ok(p.state.length > 0);
  assert.ok(p.state.every((s) => typeof s.label === 'string' && s.z != null));
  assert.ok(p.evidence.minSimilarity === 0.8 && p.evidence.baselineDays === 28);
});

test('GET /api/precedent serves a repeat request from cache without recomputing', async () => {
  const first = await request(app)
    .get('/api/precedent').query({ day: TODAY, days: '160', fresh: '1' })
    .set(authHeader()).set('X-Time-Zone', TZ);
  const started = Date.now();
  const second = await request(app)
    .get('/api/precedent').query({ day: TODAY, days: '160' })
    .set(authHeader()).set('X-Time-Zone', TZ);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.ok(Date.now() - started < 1000, 'a cache hit must not re-run the 160-day scan');
});
