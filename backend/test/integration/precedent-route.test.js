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
// A fixed "today", deliberately set well into the PAST rather than to the real
// current day.
//
// Two reasons, both learned the hard way. The engine now reads its window
// relative to `asOf`, so a historical date is a first-class query — and it is
// the only way to be sure the seeded history is the ONLY history in range.
// Sibling integration tests write annotations dated "now" ("I was feeling
// sick"), and the precedent engine legitimately treats a night's recorded
// context as part of what makes a morning similar. A test anchored on the real
// today therefore fails not because the engine is wrong but because another
// test's leftover row correctly changed the answer. Anchoring here puts the
// whole window somewhere no other test writes.
const TODAY = '2025-06-11';

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
  // Annotations too, and by PREFIX rather than this run's exact tag: a test
  // that fails partway through never reaches its own inline cleanup, and a
  // stray context row left in the window silently changes the next run's
  // answer (which is exactly how this suite first went red).
  await db.query(`DELETE FROM annotations WHERE label LIKE 'test-precedent-%'`);
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

test('a recorded night changes what counts as a precedent, end to end', async () => {
  // The behaviour this proves is the one that broke the test above when it
  // happened by accident: a night's recorded context is part of what makes a
  // morning similar. Here it is asserted deliberately, through the real
  // annotation → weeklyLedger → Gower path, not a unit stub.
  //
  // Physiology is identical across every seeded morning, so context is the
  // ONLY thing that can move the answer.
  const metricsStore = require('../../src/store/metrics');
  const sourcesStore = require('../../src/store/sources');
  await sourcesStore.registerSource({ id: SOURCE, domain: 'health', displayName: 'Precedent route test' });
  await sourcesStore.registerSource({ id: NIGHT_SOURCE, domain: 'health', displayName: 'Eight Sleep' });

  const anchor = '2025-01-15'; // a second quiet window, disjoint from TODAY's
  const meta = { testTag: TAG };
  const rows = [];
  for (let i = 150; i >= 0; i--) {
    const day = addDays(anchor, -i);
    const rough = i % 10 === 0;
    const w = ((i * 7) % 5) * 0.4;
    rows.push(
      { ts: tsFor(day), domain: 'health', metric: 'hrv', value: rough ? 38 + w * 0.2 : 62 + w, source: NIGHT_SOURCE, metadata: meta },
      { ts: tsFor(day), domain: 'health', metric: 'resting_hr', value: rough ? 60 - w * 0.1 : 51 + w * 0.2, source: NIGHT_SOURCE, metadata: meta },
      { ts: tsFor(day), domain: 'health', metric: 'sleep_hours', value: rough ? 5.6 + w * 0.05 : 7.5 + w * 0.1, source: SOURCE, metadata: meta },
      { ts: tsFor(day), domain: 'health', metric: 'active_energy', value: i % 2 === 0 ? 200 + w * 5 : 900 + w * 10, source: SOURCE, metadata: meta }
    );
  }
  await metricsStore.insertMetrics(rows);

  const ask = (day) => request(app)
    .get('/api/precedent').query({ day, days: '160', fresh: '1' })
    .set(authHeader()).set('X-Time-Zone', TZ);

  const before = await ask(anchor);
  assert.ok(before.body.precedent, 'the planted pattern must be found before any context exists');
  assert.deepEqual(before.body.precedent.context, [],
    'a window with nothing recorded reports NO context, never "a quiet night"');
  const baseline = before.body.precedent.count;

  // One drinking night, the evening BEFORE the anchor morning — so it is the
  // context for that morning's overnight readings, not for its own date. And
  // one on a single CANDIDATE morning, so exactly one past day shares it.
  const twin = addDays(anchor, -30); // a planted rough morning
  await db.query(
    `INSERT INTO annotations (start_ts, end_ts, category, label, note)
     VALUES ($1, $2, 'brief_context', $3, 'had several drinks last night'),
            ($4, $5, 'brief_context', $6, 'had several drinks last night')`,
    [
      `${addDays(anchor, -1)}T23:30:00Z`, `${anchor}T02:00:00Z`, `${TAG}-drinks`,
      `${addDays(twin, -1)}T23:30:00Z`, `${twin}T02:00:00Z`, `${TAG}-drinks`,
    ]
  );

  const after = await ask(anchor);
  const p = after.body.precedent;
  assert.ok(p);
  assert.deepEqual(p.context, ['Drinking'],
    'the night before the anchor morning must attach to THAT morning, not to its own date');

  // The guarantee worth pinning is about RANKING, not about a count crossing a
  // threshold: among mornings whose readings are alike, the one that shares
  // today's context must rank strictly above the ones that do not. That holds
  // regardless of where the similarity cutoff happens to fall.
  const twinRow = p.precedents.find((x) => x.day === twin);
  assert.ok(twinRow, 'the morning that shares today’s context must be retrieved');
  assert.deepEqual(twinRow.context, ['Drinking'], 'each precedent carries its own night’s context');
  const sober = p.precedents.filter((x) => x.day !== twin);
  assert.ok(sober.length > 0, 'the comparison needs sober mornings to rank against');
  assert.ok(
    sober.every((x) => x.similarity < twinRow.similarity),
    `a matching night must outrank every sober one (twin ${twinRow.similarity}%, best sober ${Math.max(...sober.map((x) => x.similarity))}%)`
  );
  assert.equal(p.precedents[0].day, twin, 'and it must lead the list');
  assert.ok(sober.every((x) => x.context.length === 0),
    'mornings with nothing recorded report no context rather than a claim of quiet');

  await db.query(`DELETE FROM annotations WHERE label = $1`, [`${TAG}-drinks`]);
});
