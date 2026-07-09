// gatherWellbeing/gatherHealth/gatherHabits/gatherWealth each looped over
// several metrics awaiting one DB round trip at a time (~15 serial queries
// total, on every consolidate() run — nightly + on-demand). Parallelized via
// Promise.all. The classic bug when converting a sequential loop to a
// concurrent map is a closure/key mix-up (metric A's result silently landing
// under metric B's key) — this seeds DISTINCT, distinguishable values per
// metric and asserts each one comes back under its own correct key, which a
// naive diff-the-whole-object check could miss if two metrics' numbers
// happened to collide.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const { gatherWellbeing, gatherHealth, gatherHabits, gatherWealth } = require('../../src/intelligence/consolidate');

const SOURCE = `test-consolidate-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  await db.query(`INSERT INTO sources (id, domain, display_name) VALUES ($1, 'health', 'consolidate test') ON CONFLICT (id) DO NOTHING`, [SOURCE]);
  const today = new Date();
  const rows = [
    // Distinct values per metric so a key mix-up is unmissable.
    ['wellbeing', 'mood', 4.1], ['wellbeing', 'energy', 3.2], ['wellbeing', 'focus', 2.3],
    ['health', 'steps', 11111], ['health', 'active_energy', 22222],
    ['habits', 'morning_tm', 1], ['habits', 'gratitude', 0],
    ['wealth', 'spending_discretionary', 333],
  ];
  for (const [domain, metric, value] of rows) {
    await db.query(
      `INSERT INTO metrics (ts, domain, metric, value, source) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (ts, domain, metric, source) DO UPDATE SET value = EXCLUDED.value`,
      [today.toISOString(), domain, metric, value, SOURCE]
    );
  }
});

after(async () => {
  await db.query(`DELETE FROM metrics WHERE source = $1`, [SOURCE]);
  await db.query(`DELETE FROM sources WHERE id = $1`, [SOURCE]);
  await closeDb();
});

test('gatherWellbeing keeps each metric under its own key after parallelizing', async () => {
  const d7 = new Date(Date.now() - 7 * DAY);
  const d35 = new Date(Date.now() - 35 * DAY);
  const result = await gatherWellbeing(d7, d35);
  assert.equal(result.mood.cur, 4.1);
  assert.equal(result.energy.cur, 3.2);
  assert.equal(result.focus.cur, 2.3);
});

test('gatherHealth keeps each metric under its own key after parallelizing', async () => {
  const d7 = new Date(Date.now() - 7 * DAY);
  const d35 = new Date(Date.now() - 35 * DAY);
  const result = await gatherHealth(d7, d35);
  assert.equal(result.steps.cur, 11111);
  assert.equal(result.active_energy.cur, 22222);
});

test('gatherHabits keeps each metric under its own key after parallelizing', async () => {
  const d7 = new Date(Date.now() - 7 * DAY);
  const d56 = new Date(Date.now() - 56 * DAY);
  const result = await gatherHabits(d7, d56);
  assert.equal(result.morning_tm.rate, 100);
  assert.equal(result.gratitude.rate, 0);
});

test('gatherWealth resolves all three independent fetches correctly', async () => {
  const d30 = new Date(Date.now() - 30 * DAY);
  const result = await gatherWealth(d30);
  assert.equal(result.spendingMtd, 333);
});
