// A degraded brief must get ONE automatic attempt at being better.
//
// Reported: "I have to hit the refresh button to get the full brief." A
// grounded_usable brief is publishable by design, so the serve path shipped it
// and never tried again — the only automatic repair triggers were goals_stale
// and plan_conflict, neither of which a degraded build sets. Once a morning
// build came back degraded the stub card was permanent for the day, and the
// user was the retry mechanism.
//
// What matters here, and what these tests pin: it fires, it fires ONCE per
// cooldown window (not once per request, which would mean an LLM call on every
// app open), and it never fires for a brief that is already fine.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const repairLedger = require('../../src/store/chiefBriefRepairLedger');

const app = buildTestApp();

after(async () => {
  await db.query(`DELETE FROM chief_brief_repair_attempts WHERE repair_reason = 'degraded_quality'`);
  await closeDb();
});

test('the degraded-quality repair reason is a real, distinct ledger reason', async () => {
  // The ledger is what bounds this to one attempt per cooldown. If the reason
  // string didn't round-trip, every single request would fire a scoped rebuild.
  await db.query(`DELETE FROM chief_brief_repair_attempts WHERE repair_reason = 'degraded_quality'`);
  const key = `test-brief-${Date.now()}`;

  const first = await repairLedger.eligibleForRepair('degraded_quality', { contextKey: key, cooldownMs: 600000 });
  assert.equal(first, true, 'a never-attempted degraded brief must be eligible');

  await repairLedger.recordAttempt({ repairReason: 'degraded_quality', contextKey: key, succeeded: true });

  const second = await repairLedger.eligibleForRepair('degraded_quality', { contextKey: key, cooldownMs: 600000 });
  assert.equal(second, false, 'a second request inside the cooldown must NOT fire another rebuild');
});

test('a different brief is independently eligible', async () => {
  // contextKey is the briefing row, so tomorrow's degraded build is not
  // suppressed by today's already-spent attempt.
  const keyA = `test-brief-a-${Date.now()}`;
  const keyB = `test-brief-b-${Date.now()}`;
  await repairLedger.recordAttempt({ repairReason: 'degraded_quality', contextKey: keyA, succeeded: true });
  assert.equal(
    await repairLedger.eligibleForRepair('degraded_quality', { contextKey: keyB, cooldownMs: 600000 }),
    true
  );
});

test('the serve path only attempts repair for a degraded, non-pending card', async () => {
  // Source-level guard: the trigger condition is the whole contract, and an
  // over-broad one would fire a scoped LLM rebuild on every cache-hit serve of
  // a perfectly good brief.
  const SRC = require('node:fs').readFileSync(require.resolve('../../src/routes/briefing'), 'utf8');
  const block = SRC.slice(SRC.indexOf('Automatic repair of a DEGRADED'), SRC.indexOf('Hoisted out of the try block'));
  assert.match(block, /servedTier === 'grounded_usable'/, 'only a degraded card may be repaired');
  assert.match(block, /!cachedContent\.chiefBriefPending/, 'a still-building brief must not be repaired');
  assert.match(block, /eligibleForRepair\('degraded_quality'/, 'must go through the durable ledger, not fire per request');
  assert.match(block, /runScopedRepairDeduped\(/, 'must reuse the shared in-flight repair, not a second mechanism');
});

test('GET /briefing still serves normally with the repair path wired in', async () => {
  // A smoke check that the new block cannot throw on the common path — an
  // exception here would take down the whole brief, which is far worse than
  // the degraded card it exists to improve.
  const request = require('supertest');
  const res = await request(app).get('/api/briefing').set(authHeader()).set('X-Time-Zone', 'America/New_York');
  assert.ok(res.status === 200 || res.status === 503, `unexpected status ${res.status}`);
});

test('the recorded attempt uses the SAME identity the eligibility check used', () => {
  // The cooldown is silently inert if these diverge: isEligible treats a
  // checked key that differs from the stored one as "new context, go ahead",
  // so checking prior.id while storing null makes every request eligible —
  // a scoped LLM rebuild on every app open, which is the rebuild storm this
  // ledger exists to prevent.
  const SRC = require('node:fs').readFileSync(require.resolve('../../src/routes/briefing'), 'utf8');
  const serve = SRC.slice(SRC.indexOf('Automatic repair of a DEGRADED'), SRC.indexOf('Hoisted out of the try block'));
  assert.match(serve, /const degradedRepairKey =/, 'one key must be computed');
  assert.match(serve, /contextKey: degradedRepairKey/, 'and used for the eligibility check');
  assert.match(serve, /runScopedRepairDeduped\(prior, 'degraded_quality', degradedRepairKey\)/,
    'and threaded into the rebuild so recordAttempt stores the same identity');
  assert.match(SRC, /repairContextKey \?\? null/, 'recordAttempt must persist the caller-supplied key');
});
