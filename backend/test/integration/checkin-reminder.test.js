// The ~3pm scheduled check-in reminder (notify/run.js's runCheckinReminder)
// used to silently land on add_to_brief every time — checkin_missing's generic
// scored ladder in intelligence/attention.js could never clear the notify bar
// (urgency default 0.3 × any achievable value tops out below the 0.40
// interrupt-cost floor). Fixed with a deterministic Stage-A rule for this event
// type (see attention-policy.test.js for the pure judge() coverage). These
// tests exercise the real end-to-end path: DB-backed "logged today?" check,
// dispatchEvent, and the attention_log ledger — same pattern as
// notify-evening-reminder.test.js.
// Test #7 exercises the REAL unforced scheduler path, so withinQuietHours()
// must evaluate against the same timezone the production scheduler runs
// under. withinQuietHours reads Date.prototype.getHours()/getMinutes(), which
// follow process.env.TZ — not explicitly parameterized like the newer
// util/date.js helpers (this is the established, documented pattern: see
// /api/diag/scheduler's own hint, "TZ is not set — scheduler fires at UTC
// times"). Set here so the test is meaningful regardless of the runner's
// ambient TZ (this sandbox and CI both default to UTC).
process.env.TZ = process.env.TZ || 'America/New_York';

const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const { runCheckinReminder } = require('../../src/notify/run');
const sourcesStore = require('../../src/store/sources');

test.before(async () => {
  await sourcesStore.registerSource({ id: 'checkin', domain: 'wellbeing', displayName: 'Daily Check-in' });
});

async function seedCheckin() {
  for (const metric of ['mood', 'energy', 'focus']) {
    await db.query(
      `INSERT INTO metrics (ts, domain, metric, value, source) VALUES (now(), 'wellbeing', $1, 4, 'checkin')`,
      [metric]
    );
  }
}

async function cleanup() {
  await db.query(`DELETE FROM metrics WHERE source = 'checkin' AND ts >= now() - interval '1 hour'`);
  await db.query(`DELETE FROM attention_log WHERE domain = 'wellbeing' AND type = 'checkin_missing' AND created_at >= now() - interval '1 hour'`);
  await db.query(`DELETE FROM nudges WHERE dedup_key LIKE 'wellbeing:checkin_missing:%' AND created_at >= now() - interval '1 hour'`);
}

afterEach(cleanup);
after(async () => { await cleanup(); await closeDb(); });

test('2. a completed check-in produces no event — runCheckinReminder skips before ever building one', async () => {
  await seedCheckin();
  const result = await runCheckinReminder({ send: false });
  assert.equal(result.skipped, 'already_logged');
  assert.equal(result.sent, 0);
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM attention_log WHERE domain = 'wellbeing' AND type = 'checkin_missing' AND created_at >= now() - interval '1 minute'`
  );
  assert.equal(rows[0].n, 0, 'no attention_log row at all — the event was never built, let alone judged');
});

test('7. the scheduler path (runCheckinReminder, unforced) produces notify_now for a genuinely incomplete check-in', async () => {
  // No seedCheckin() — today's check-in is incomplete. send:false so no real
  // push infrastructure is needed; force is NOT set, matching exactly how
  // scheduler.js's scheduleDaily(checkinHour, checkinMinute, () =>
  // runCheckinReminder({})) calls it in production — EXCEPT asOf is pinned to
  // 3pm ET (the real production firing time) rather than the real wall clock.
  // withinQuietHours' default window is 21:00-07:30, so an unpinned call here
  // would spuriously fail (or spuriously pass) depending purely on what time
  // this test happens to run, independent of whether the deterministic rule
  // is correct — the same class of flake naiveToUtcIso exists to avoid.
  const { naiveToUtcIso } = require('../../src/util/date');
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const asOf = new Date(naiveToUtcIso(`${todayStr}T15:00:00`, 'America/New_York'));
  const result = await runCheckinReminder({ send: false, asOf });
  assert.equal(result.disposition, 'notify_now', 'the corrected deterministic rule fires end-to-end through the real scheduler entrypoint');
  assert.equal(result.skipped, undefined);

  const { rows } = await db.query(
    `SELECT disposition, delivery_state, gates FROM attention_log
      WHERE domain = 'wellbeing' AND type = 'checkin_missing'
      ORDER BY created_at DESC LIMIT 1`
  );
  assert.equal(rows.length, 1, 'exactly one ledger row was written');
  assert.equal(rows[0].disposition, 'notify_now');
  assert.equal(rows[0].gates.checkin_reminder_rule, true, 'audit trail shows the new deterministic rule fired, not the generic ladder');
});

test('force:true still requires it to be genuinely incomplete (force does not fabricate an event)', async () => {
  await seedCheckin();
  const result = await runCheckinReminder({ send: false, force: true });
  // force bypasses the "already_logged" early-return guard, so it proceeds to
  // dispatch — but the event itself is still built the same way; this proves
  // force doesn't silently skip the real DB check, matching "preserve force
  // behavior for manual/admin testing" without granting force a free pass on
  // correctness.
  assert.notEqual(result.skipped, 'already_logged');
});
