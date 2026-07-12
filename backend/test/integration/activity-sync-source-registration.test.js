// Bug bash finding (the root cause behind the steps-undercounting report):
// metrics.source has a hard FK to sources(id), but syncActivityMinutes()
// wrote metrics under sources 'activity' and 'activity_est' without EVER
// registering either one. Every call has thrown a foreign-key violation
// since this file was written — caught by its own blanket try/catch and only
// console.error'd, so it looked like a no-op rather than a crash. This meant
// health:exercise_minutes never fed training-load/trends for ANY logged
// activity, and a no-watch activity's estimated steps/active-energy never
// credited the day's totals — for every user, always, silently.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const { syncActivityMinutes } = require('../../src/intelligence/activity-sync');

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' });

async function cleanup() {
  await db.query(`DELETE FROM activity_logs WHERE log_date = $1 AND note = 'bug-bash-test'`, [TODAY]);
  await db.query(`DELETE FROM metrics WHERE domain = 'health' AND source IN ('activity', 'activity_est')
                    AND (ts AT TIME ZONE $1)::date = $2::date`, [process.env.TZ || 'America/New_York', TODAY]);
}

after(async () => {
  await cleanup();
  await closeDb();
});

test('syncActivityMinutes actually persists exercise_minutes and no-watch step/energy estimates instead of silently throwing on an unregistered source', async () => {
  await cleanup();
  await db.query(
    `INSERT INTO activity_logs (log_date, activity_type, label, duration_min, note, no_watch)
     VALUES ($1, 'basketball', 'Bug bash basketball', 70, 'bug-bash-test', true)`,
    [TODAY]
  );

  await syncActivityMinutes(TODAY);

  const { rows: exerciseRows } = await db.query(
    `SELECT value FROM metrics WHERE domain = 'health' AND metric = 'exercise_minutes' AND source = 'activity'
       AND (ts AT TIME ZONE $1)::date = $2::date`,
    [process.env.TZ || 'America/New_York', TODAY]
  );
  assert.equal(exerciseRows.length, 1, 'exercise_minutes must actually be written, not silently dropped by an FK violation');
  assert.equal(Number(exerciseRows[0].value), 70);

  const { rows: stepsRows } = await db.query(
    `SELECT value FROM metrics WHERE domain = 'health' AND metric = 'steps' AND source = 'activity_est'
       AND (ts AT TIME ZONE $1)::date = $2::date`,
    [process.env.TZ || 'America/New_York', TODAY]
  );
  assert.equal(stepsRows.length, 1, 'the no-watch step estimate must actually be written');
  assert.equal(Number(stepsRows[0].value), 130 * 70); // basketball spm(130) * 70 min, per activity-estimates.js
});
