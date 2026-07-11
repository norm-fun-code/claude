// DB-backed halves of the learning-loop closures: the calibration ledger
// (records every forecast-vs-actual comparison; rolling hit rate), the
// recommendation ledger's outcome aggregation, and the empirical confidence
// cap on tomorrow's forecast (never claim more confidence than the last 30
// days of forecasts actually earned).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const calibration = require('../../src/store/forecastCalibration');
const recommendationsStore = require('../../src/store/recommendations');

// Distant past days so test rows never collide with real ledger rows, cleaned
// up by range after.
const DAY0 = new Date('1990-01-01T12:00:00Z');
const dayStr = (i) => new Date(DAY0.getTime() + i * 864e5).toISOString().slice(0, 10);
const TAG = `learn-db-${Date.now()}`;

after(async () => {
  await db.query(`DELETE FROM forecast_calibration WHERE day < '1991-01-01'`);
  await db.query(`DELETE FROM recommendations WHERE title LIKE $1`, [`%${TAG}%`]);
  await closeDb();
});

test('calibration record is idempotent per day — a same-day rebuild cannot double-count', async () => {
  await calibration.record({ day: dayStr(0), predictedBand: 'green', predictedScore: 72, confidence: 61, actualBand: 'yellow', actualScore: 55 });
  await calibration.record({ day: dayStr(0), predictedBand: 'yellow', predictedScore: 50, confidence: 80, actualBand: 'yellow', actualScore: 55 });
  const { rows } = await db.query(`SELECT predicted_band, hit FROM forecast_calibration WHERE day = $1`, [dayStr(0)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].predicted_band, 'green', 'first comparison of the day wins');
  assert.equal(rows[0].hit, false);
});

test('hitRate counts hits over rated days within the window only', async () => {
  // 3 more rows: 2 hits, 1 miss (plus the miss from the test above = 4 rated).
  await calibration.record({ day: dayStr(1), predictedBand: 'green', predictedScore: 70, confidence: 70, actualBand: 'green', actualScore: 68 });
  await calibration.record({ day: dayStr(2), predictedBand: 'red', predictedScore: 30, confidence: 75, actualBand: 'red', actualScore: 28 });
  await calibration.record({ day: dayStr(3), predictedBand: 'green', predictedScore: 65, confidence: 55, actualBand: 'yellow', actualScore: 50 });

  // These 1990 rows are outside any rolling window — a wide window query
  // scoped to include them verifies the math; the default 30d window sees none.
  const recent = await calibration.hitRate({ days: 30 });
  const wide = await calibration.hitRate({ days: 20000 });
  assert.equal(wide.n >= 4, true);
  assert.equal(wide.hits >= 2, true);
  assert.ok(recent.n === 0 || recent.rate == null || recent.n < wide.n, 'old rows are outside the 30-day window');
});

test('outcomeHistoryByDedupKey aggregates measured verdicts per basis identity', async () => {
  const mk = (dedupKey, delta, dir) => db.query(
    `INSERT INTO recommendations (type, title, surfaced_in, dedup_key, expected_direction, outcome_delta, outcome_measured_at)
     VALUES ('leverage', $1, 'briefing', $2, $3, $4, now())`,
    [`rec ${TAG} ${Math.random()}`, dedupKey, dir, delta]
  );
  const KEY = `correlation|test:lever|test:outcome|${TAG}`;
  await mk(KEY, 2.0, 'up');   // helped
  await mk(KEY, -0.5, 'up');  // no effect
  await mk(KEY, -1.0, 'down'); // helped
  // Pending row (no outcome yet) must not count:
  await db.query(
    `INSERT INTO recommendations (type, title, surfaced_in, dedup_key, expected_direction)
     VALUES ('leverage', $1, 'briefing', $2, 'up')`,
    [`rec ${TAG} pending`, KEY]
  );

  const hist = await recommendationsStore.outcomeHistoryByDedupKey({ withinDays: 5 });
  assert.deepEqual(hist[KEY], { helped: 2, noEffect: 1 });
});

test("tomorrow's forecast confidence is capped at the empirical 30-day hit rate once n >= 10", async () => {
  // Seed a RECENT poor track record: 10 rated days, 4 hits (40%).
  const today = Date.now();
  for (let i = 1; i <= 10; i++) {
    const day = new Date(today - i * 864e5).toISOString().slice(0, 10);
    await db.query(
      `INSERT INTO forecast_calibration (day, predicted_band, actual_band, hit)
       VALUES ($1, 'green', $2, $3) ON CONFLICT (day) DO NOTHING`,
      [day, i <= 4 ? 'green' : 'yellow', i <= 4]
    );
  }
  try {
    const { computeTodayForecast } = require('../../src/intelligence/predict');
    // High recovery score → forecastTomorrow's heuristic confidence lands well
    // above 40% (score 90 → proj ~94 → confidence ~79) — the cap must bite.
    const result = await computeTodayForecast({ recovery: { score: 90, band: 'green', parts: {} } });
    assert.ok(result.tomorrow, 'expected a tomorrow forecast');
    const track = await calibration.hitRate({ days: 30 });
    assert.ok(track.n >= 10, `expected >=10 rated days, got ${track.n}`);
    assert.equal(result.tomorrow.confidence, Math.round(track.rate * 100), 'stated confidence = empirical hit rate');
    assert.equal(result.tomorrow.confidenceCapped, true);
    assert.deepEqual(result.tomorrow.trackRecord, { n: track.n, hits: track.hits });
  } finally {
    await db.query(`DELETE FROM forecast_calibration WHERE day > $1`, [new Date(today - 12 * 864e5).toISOString().slice(0, 10)]);
  }
});
