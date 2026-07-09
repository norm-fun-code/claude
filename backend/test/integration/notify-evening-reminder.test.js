// The evening reminder used to be three separate pushes (check-in, habits,
// day-context) landing within 5 minutes of each other — merged into one
// (notification-load review) that names whichever pieces are still open.
// Exercises the real DB-backed "logged today?" checks (metrics + day_journal)
// plus the nudges dedup table, same pattern as nudges-concurrent-dedup.test.js.
const test = require('node:test');
const { after, beforeEach } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const { runEveningReminder } = require('../../src/notify/run');
const dayJournal = require('../../src/store/dayJournal');
const sourcesStore = require('../../src/store/sources');

const TZ = 'America/New_York';
const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const TEST_SOURCE_TAG = `test-evening-reminder-${Date.now()}`;

test.before(async () => {
  await sourcesStore.registerSource({ id: 'checkin', domain: 'wellbeing', displayName: 'Daily Check-in' });
  await sourcesStore.registerSource({ id: 'habits', domain: 'habits', displayName: 'Habit Stack' });
});

async function seedCheckin() {
  for (const metric of ['mood', 'energy', 'focus']) {
    await db.query(
      `INSERT INTO metrics (ts, domain, metric, value, source) VALUES (now(), 'wellbeing', $1, 5, 'checkin')`,
      [metric]
    );
  }
}
async function seedHabits() {
  for (const metric of ['morning_tm', 'afternoon_tm', 'gratitude', 'cold_shower', 'exercise', 'eat_healthy']) {
    await db.query(
      `INSERT INTO metrics (ts, domain, metric, value, source) VALUES (now(), 'habits', $1, 1, 'habits')`,
      [metric]
    );
  }
}
async function seedDayContext() {
  await dayJournal.create({ text: `journal entry ${TEST_SOURCE_TAG}`, entryDate: today, source: 'voice' });
}

async function cleanup() {
  await db.query(`DELETE FROM metrics WHERE source IN ('checkin', 'habits') AND ts >= now() - interval '1 hour'`);
  await db.query(`DELETE FROM day_journal WHERE text LIKE $1`, [`%${TEST_SOURCE_TAG}%`]);
  await db.query(`DELETE FROM nudges WHERE dedup_key = $1`, [`evening_reminder:${today}`]);
}

beforeEach(cleanup);
after(async () => {
  await cleanup();
  await closeDb();
});

test('all three logged today: no push, skipped', async () => {
  await Promise.all([seedCheckin(), seedHabits(), seedDayContext()]);
  const result = await runEveningReminder({ send: false });
  assert.equal(result.skipped, 'already_logged');
  assert.equal(result.sent, 0);
});

test('nothing logged: one push naming all three', async () => {
  const result = await runEveningReminder({ send: false });
  assert.equal(result.skipped, undefined);
  const { rows } = await db.query(`SELECT title, body FROM nudges WHERE dedup_key = $1`, [`evening_reminder:${today}`]);
  assert.equal(rows.length, 1, 'exactly one combined nudge row, not three separate ones');
  assert.match(rows[0].body, /how your day went/);
  assert.match(rows[0].body, /today's habits/);
  assert.match(rows[0].body, /a quick recap/);
});

test('only day-context missing: push names just that one thing', async () => {
  await Promise.all([seedCheckin(), seedHabits()]);
  await runEveningReminder({ send: false });
  const { rows } = await db.query(`SELECT title, body FROM nudges WHERE dedup_key = $1`, [`evening_reminder:${today}`]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, 'Before you wind down — log a quick recap?');
});

test('a second run the same day (still incomplete) does not push again', async () => {
  const first = await runEveningReminder({ send: false });
  assert.equal(first.skipped, undefined);
  const second = await runEveningReminder({ send: false });
  // Either the recentlySentKeys() dedup or recordNudge's own concurrent-insert
  // guard can be the one that catches it depending on timing — what matters is
  // it's skipped either way and only one row ever lands for the day.
  assert.ok(second.skipped, 'second same-day run must be skipped, not push again');
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM nudges WHERE dedup_key = $1`, [`evening_reminder:${today}`]);
  assert.equal(rows[0].n, 1, 'still only one row — no duplicate push for the same day');
});
