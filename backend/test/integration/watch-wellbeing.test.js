// Same-day reaction to a rough check-in (full-repo review, improvement #2 —
// "make it notice things when they happen"). The temporal audit's scenario
// (d): the user logs mood 2/5 at 3pm and the system did nothing until
// tomorrow's brief — the checkin route just wrote metrics and returned. Now
// it fires watchWellbeing(), which builds a normalized AttentionEvent and
// routes it through the Attention Policy (notify/dispatch.js) instead of
// deciding for itself — the SAME judge() that every other watcher/nudge
// surface now goes through. Dedup lives in attention_log's cooldown (any
// judged, user-facing disposition — not just an actually-delivered push —
// suppresses a repeat of the SAME fact); a push (when one is warranted) also
// still writes the pre-existing `nudges` table so GET /api/nudges (the
// mobile "recent proactive messages" log) keeps working unchanged.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const { watchWellbeing } = require('../../src/intelligence/watch');

const app = buildTestApp();

async function cleanupLedgers() {
  await db.query(`DELETE FROM attention_log WHERE event_key LIKE 'wellbeing:low_checkin:%'`);
  await db.query(`DELETE FROM nudges WHERE dedup_key LIKE 'wellbeing:low_checkin:%'`);
}
async function cleanupCheckins() {
  await db.query(`DELETE FROM metrics WHERE domain = 'wellbeing' AND source = 'checkin' AND ts >= now() - interval '1 day'`);
}

after(async () => {
  await cleanupLedgers();
  await cleanupCheckins();
  await closeDb();
});

test('a low check-in judges to a user-facing disposition, once per day (policy cooldown)', async (t) => {
  await cleanupLedgers();
  // Direct call first (deterministic — the route's hook is fire-and-forget).
  // force:true bypasses quiet hours so the test passes at any time of day;
  // send:false records the decision without actually pushing (no devices in
  // this environment anyway).
  const first = await watchWellbeing({ mood: 2, energy: 4, focus: 3, force: true, send: false });
  assert.equal(first.generated, 1);
  assert.ok(['notify_now', 'add_to_brief', 'offer_action'].includes(first.disposition), `expected a user-facing disposition, got ${first.disposition}`);
  assert.match(first.nudge.body, /mood is running low/);
  assert.match(first.nudge.body, /Downshift the rest of the day/);

  // The SAME fact again the same day: the policy's cooldown gate (attention_log,
  // keyed by event_key) suppresses it — no manual "mark as sent" needed, since
  // cooldown is keyed off the DECISION being recorded, not delivery status.
  const again = await watchWellbeing({ mood: 1, energy: 1, focus: 1, force: true, send: false });
  assert.equal(again.disposition, 'store_silently', 'second low check-in the same day must not double-surface');
});

test('a fine check-in generates nothing', async () => {
  await cleanupLedgers();
  const r = await watchWellbeing({ mood: 4, energy: 3, focus: 5, force: true, send: false });
  assert.equal(r.generated, 0);
  const { rows } = await db.query(`SELECT 1 FROM attention_log WHERE event_key LIKE 'wellbeing:low_checkin:%'`);
  assert.equal(rows.length, 0);
});

test('multiple low dimensions read naturally ("mood and energy are running low")', async () => {
  await cleanupLedgers();
  const r = await watchWellbeing({ mood: 2, energy: 1, focus: 4, force: true, send: false });
  assert.equal(r.generated, 1);
  assert.match(r.nudge.body, /mood and energy are running low/);
});

test('POST /checkin with a low mood triggers the watcher end-to-end through the policy', async () => {
  await cleanupLedgers();
  await cleanupCheckins();
  const res = await request(app)
    .post('/api/checkin')
    .set(authHeader())
    .send({ mood: 1, energy: 4, focus: 4 })
    .timeout(10000);
  assert.equal(res.status, 200);
  assert.ok(res.body.written >= 1, 'check-in metrics written');

  // The watcher is fire-and-forget off the request path — poll briefly for
  // the attention_log row instead of racing it.
  let row = null;
  for (let i = 0; i < 20 && !row; i++) {
    const { rows } = await db.query(`SELECT disposition, reason FROM attention_log WHERE event_key LIKE 'wellbeing:low_checkin:%'`);
    row = rows[0] ?? null;
    if (!row) await new Promise((r2) => setTimeout(r2, 100));
  }
  // Quiet-hours caveat: the route path (deliberately) does NOT force — a low
  // check-in logged at 2am shouldn't push. Under the policy, quiet hours
  // DEFER (add_to_brief) rather than dropping the event, so accept either a
  // notify-shaped disposition or a deferred one; verify which regime we're
  // in so the assertion is never vacuous.
  const { withinQuietHours } = require('../../src/intelligence/nudges');
  assert.ok(row, 'expected a judged wellbeing event recorded via the route hook, regardless of quiet hours');
  if (withinQuietHours(new Date())) {
    assert.notEqual(row.disposition, 'notify_now', 'inside quiet hours the policy must not push');
  } else {
    assert.equal(row.disposition, 'notify_now');
  }
});
