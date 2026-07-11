// Same-day reaction to a rough check-in (full-repo review, improvement #2 —
// "make it notice things when they happen"). The temporal audit's scenario
// (d): the user logs mood 2/5 at 3pm and the system did nothing until
// tomorrow's brief — the checkin route just wrote metrics and returned. Now
// it fires watchWellbeing() (the same pattern health ingests use with
// runWatch), which records a supportive downshift nudge, deduped once per
// day via the nudge ledger.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const { watchWellbeing } = require('../../src/intelligence/watch');

const app = buildTestApp();

async function cleanupNudges() {
  await db.query(`DELETE FROM nudges WHERE dedup_key LIKE 'watch:wellbeing:%'`);
}
async function cleanupCheckins() {
  await db.query(`DELETE FROM metrics WHERE domain = 'wellbeing' AND source = 'checkin' AND ts >= now() - interval '1 day'`);
}

after(async () => {
  await cleanupNudges();
  await cleanupCheckins();
  await closeDb();
});

test('a low check-in records a wellbeing nudge, once per day', async () => {
  await cleanupNudges();
  // Direct call first (deterministic — the route's hook is fire-and-forget).
  // force:true bypasses quiet hours so the test passes at any time of day;
  // send:false records without pushing (no devices in this environment anyway).
  const first = await watchWellbeing({ mood: 2, energy: 4, focus: 3, force: true, send: false });
  assert.equal(first.generated, 1);
  assert.match(first.nudge.body, /mood is running low/);
  assert.match(first.nudge.body, /Downshift the rest of the day/);

  // The once-per-day ledger counts SENT nudges (recentlySentKeys semantics,
  // same as runWatch) — in production the push marks the row sent; with
  // send:false the test simulates that delivery explicitly.
  await db.query(`UPDATE nudges SET status = 'sent', sent_at = now() WHERE dedup_key LIKE 'watch:wellbeing:%'`);

  const again = await watchWellbeing({ mood: 1, energy: 1, focus: 1, force: true, send: false });
  assert.equal(again.generated, 0, 'second low check-in the same day must not double-ping');
  assert.equal(again.skipped, 'already_sent');
});

test('a fine check-in generates nothing', async () => {
  await cleanupNudges();
  const r = await watchWellbeing({ mood: 4, energy: 3, focus: 5, force: true, send: false });
  assert.equal(r.generated, 0);
  const { rows } = await db.query(`SELECT 1 FROM nudges WHERE dedup_key LIKE 'watch:wellbeing:%'`);
  assert.equal(rows.length, 0);
});

test('multiple low dimensions read naturally ("mood and energy are running low")', async () => {
  await cleanupNudges();
  const r = await watchWellbeing({ mood: 2, energy: 1, focus: 4, force: true, send: false });
  assert.equal(r.generated, 1);
  assert.match(r.nudge.body, /mood and energy are running low/);
});

test('POST /checkin with a low mood triggers the watcher end-to-end', async () => {
  await cleanupNudges();
  await cleanupCheckins();
  const res = await request(app)
    .post('/api/checkin')
    .set(authHeader())
    .send({ mood: 1, energy: 4, focus: 4 })
    .timeout(10000);
  assert.equal(res.status, 200);
  assert.ok(res.body.written >= 1, 'check-in metrics written');

  // The watcher is fire-and-forget off the request path — poll briefly for
  // the nudge row instead of racing it.
  let row = null;
  for (let i = 0; i < 20 && !row; i++) {
    const { rows } = await db.query(`SELECT title, body FROM nudges WHERE dedup_key LIKE 'watch:wellbeing:%'`);
    row = rows[0] ?? null;
    if (!row) await new Promise((r2) => setTimeout(r2, 100));
  }
  // Quiet-hours caveat: the route path (deliberately) does NOT force — a low
  // check-in logged at 2am shouldn't ping. If this test runs inside quiet
  // hours, the watcher correctly skips; accept either outcome but verify
  // which one we're in so the assertion is never vacuous.
  const { withinQuietHours } = require('../../src/intelligence/nudges');
  if (withinQuietHours(new Date())) {
    assert.equal(row, null, 'inside quiet hours the route-triggered watcher must stay silent');
  } else {
    assert.ok(row, 'expected a wellbeing nudge recorded via the route hook');
    assert.match(row.body, /mood is running low/);
  }
});
