// P1 hardening: atomic Attention-Policy delivery (reserve -> push -> finalize).
//
// Before migration 045 + the reserveDelivery/finalizeDelivery rework, dispatch
// read the budget/cooldown snapshot, judged, PUSHED, then recorded — so two
// concurrent dispatchers (overlapping scheduler tick, two Railway replicas, a
// manual run racing a cron) could both pass the same gate and double-send, or
// two distinct events could both pass a budget check that had room for one.
//
// These tests drive GENUINELY concurrent transactions: each reserveDelivery()
// runs in its own pooled connection and contends on the one cluster-wide
// advisory lock, so Promise.all() of two dispatches is real DB-level
// contention, made deterministic by that lock. expo.sendPush and the devices
// store are stubbed (module objects) so no push infrastructure is needed and
// the send count is directly observable.
const test = require('node:test');
const { after, afterEach, beforeEach, before } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const dispatch = require('../../src/notify/dispatch');
const events = require('../../src/intelligence/events');
const expo = require('../../src/notify/expo');
const devicesStore = require('../../src/store/devices');

const ORIG_SEND = expo.sendPush;
const ORIG_TOKENS = devicesStore.listActiveTokens;
const ORIG_DEACTIVATE = devicesStore.deactivate;
const ORIG_BUDGET = process.env.ATTENTION_DAILY_BUDGET;
const ORIG_CRIT = process.env.ATTENTION_CRITICAL_RESERVE;

let sendCount = 0;
function stubDelivery({ failEveryTime = false } = {}) {
  sendCount = 0;
  devicesStore.listActiveTokens = async () => ['ExponentPushToken[ZZtest-device]'];
  devicesStore.deactivate = async () => {};
  expo.sendPush = async () => {
    sendCount += 1;
    if (failEveryTime) throw new Error('simulated Expo failure');
    return { ok: true, sent: 1, tickets: [], invalidTokens: [] };
  };
}

async function cleanup() {
  await db.query(`DELETE FROM attention_log WHERE subject LIKE 'ZZatomic%'`);
  await db.query(`DELETE FROM nudges WHERE dedup_key LIKE '%ZZatomic%'`);
}

// The daily interruption budget is a GLOBAL per-day count over attention_log —
// so delivered rows any earlier integration file left in the shared test DB
// would exhaust it and defer our events before they ever race. Neutralize that
// baseline once (backdate, don't delete, so nothing another file asserts on
// vanishes): these tests own the budget for "today". A no-op in a clean DB.
before(async () => {
  await db.query(
    `UPDATE attention_log SET created_at = now() - interval '3 days'
      WHERE delivered_channel = 'push'
        AND (created_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`
  );
});

beforeEach(async () => { await cleanup(); stubDelivery(); });
afterEach(() => {
  expo.sendPush = ORIG_SEND;
  devicesStore.listActiveTokens = ORIG_TOKENS;
  devicesStore.deactivate = ORIG_DEACTIVATE;
  if (ORIG_BUDGET === undefined) delete process.env.ATTENTION_DAILY_BUDGET; else process.env.ATTENTION_DAILY_BUDGET = ORIG_BUDGET;
  if (ORIG_CRIT === undefined) delete process.env.ATTENTION_CRITICAL_RESERVE; else process.env.ATTENTION_CRITICAL_RESERVE = ORIG_CRIT;
});
after(async () => { await cleanup(); await closeDb(); });

function anomaly(subject, asOf) {
  return events.baseEvent({
    source: 'watch_health', domain: 'health', type: 'anomaly', subject,
    title: `${subject} spike`, body: 'x', observedAt: asOf,
    signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 }, urgencyHint: 0.9,
  });
}

async function deliveredCount(subjectLike) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM attention_log WHERE subject LIKE $1 AND delivery_state = 'delivered'`, [subjectLike]);
  return rows[0].n;
}

test('two concurrent dispatches of the SAME event produce exactly one push', async () => {
  const asOf = new Date();
  const ev = anomaly('ZZatomicSame', asOf);
  const [a, b] = await Promise.all([
    dispatch.dispatchEvent(ev, { asOf, send: true, force: true }),
    dispatch.dispatchEvent(ev, { asOf, send: true, force: true }),
  ]);
  const delivered = [a, b].filter((r) => r.delivered).length;
  assert.equal(delivered, 1, 'exactly one dispatch should deliver');
  assert.equal(sendCount, 1, 'expo.sendPush must be called exactly once');
  assert.equal(await deliveredCount('ZZatomicSame'), 1, 'exactly one delivered ledger row');
});

test('two DISTINCT concurrent events cannot exceed the daily budget', async () => {
  process.env.ATTENTION_DAILY_BUDGET = '1'; // one slot for the whole day
  const asOf = new Date();
  const [a, b] = await Promise.all([
    dispatch.dispatchEvent(anomaly('ZZatomicBudgetA', asOf), { asOf, send: true, force: true }),
    dispatch.dispatchEvent(anomaly('ZZatomicBudgetB', asOf), { asOf, send: true, force: true }),
  ]);
  const delivered = [a, b].filter((r) => r.delivered).length;
  assert.equal(delivered, 1, 'only one of two distinct events can spend the single budget slot');
  assert.equal(sendCount, 1, 'exactly one push sent');
  const total = await deliveredCount('ZZatomicBudget%');
  assert.equal(total, 1, 'delivered-today for these events must equal the budget, never exceed it');
});

test('two concurrent critical events cannot exceed the critical reserve', async () => {
  process.env.ATTENTION_CRITICAL_RESERVE = '1';
  const asOf = new Date();
  // Both match the CRITICAL_ALLOWLIST at magnitude >= 0.85 (distinct subjects).
  const critEvent = (subject) => events.baseEvent({
    source: 'watch_health', domain: 'health', type: 'anomaly', subject,
    title: `${subject} critical`, body: 'x', observedAt: asOf, critical: true,
    signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 },
  });
  const [a, b] = await Promise.all([
    dispatch.dispatchEvent(critEvent('respiratory_rate'), { asOf, send: true, force: true }),
    dispatch.dispatchEvent(critEvent('resting_hr'), { asOf, send: true, force: true }),
  ]);
  const delivered = [a, b].filter((r) => r.delivered).length;
  assert.equal(delivered, 1, 'the critical reserve of 1 admits exactly one');
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM attention_log
      WHERE subject IN ('respiratory_rate','resting_hr')
        AND gates->>'critical_reserve_consumed' = 'true' AND delivery_state = 'delivered'`);
  assert.equal(rows[0].n, 1, 'exactly one row actually consumed the critical reserve');
  await db.query(`DELETE FROM attention_log WHERE subject IN ('respiratory_rate','resting_hr')`);
  await db.query(`DELETE FROM nudges WHERE dedup_key LIKE '%respiratory_rate%' OR dedup_key LIKE '%resting_hr%'`);
});

test('a failed push is retry-eligible (does not start the cooldown), then capped after MAX attempts', async () => {
  const attention = require('../../src/store/attention');
  stubDelivery({ failEveryTime: true });
  const asOf = new Date();
  // Each attempt re-emits the same fact; a failed push must NOT suppress it,
  // so a fresh dispatch should keep trying — up to MAX_DELIVERY_ATTEMPTS.
  let sawSkipReason = null;
  for (let i = 0; i < attention.MAX_DELIVERY_ATTEMPTS + 2; i++) {
    const r = await dispatch.dispatchEvent(anomaly('ZZatomicRetry', asOf), { asOf, send: true, force: true });
    if (r.skippedReason) sawSkipReason = r.skippedReason;
  }
  const { rows: failed } = await db.query(
    `SELECT count(*)::int AS n FROM attention_log WHERE subject = 'ZZatomicRetry' AND delivery_state = 'failed'`);
  assert.equal(failed[0].n, attention.MAX_DELIVERY_ATTEMPTS, 'retries the fact up to the cap, no more');
  assert.match(String(sawSkipReason || ''), /retries exhausted/i, 'past the cap it is explicitly skipped, not permanently silent');
  // Cooldown was never started (no delivered row), so the fact is not locked out.
  const { rows: delivered } = await db.query(
    `SELECT count(*)::int AS n FROM attention_log WHERE subject = 'ZZatomicRetry' AND delivered_channel IS NOT NULL`);
  assert.equal(delivered[0].n, 0, 'a failed push never records a surfaced/cooldown-starting row');
});

test('a dry run consumes no reservation and no budget', async () => {
  const asOf = new Date();
  const before = await deliveredCount('ZZatomic%');
  const r = await dispatch.dispatchEvent(anomaly('ZZatomicDry', asOf), { asOf, send: false, force: true });
  assert.equal(r.delivered, false);
  assert.equal(sendCount, 0, 'a dry run never calls sendPush');
  const { rows } = await db.query(
    `SELECT delivery_state, delivered_channel FROM attention_log WHERE subject = 'ZZatomicDry'`);
  assert.equal(rows.length, 1, 'the dry run still records a single audit row');
  assert.equal(rows[0].delivery_state, 'stored', 'audit only — never a reserved/delivered slot');
  assert.equal(rows[0].delivered_channel, null, 'so it consumes neither the budget nor the cooldown');
  assert.equal(await deliveredCount('ZZatomic%'), before, 'delivered-today count is unchanged by a dry run');
});

test('repeated dispatch of the same event stays idempotent (one delivery total)', async () => {
  const asOf = new Date();
  const ev = anomaly('ZZatomicIdem', asOf);
  await dispatch.dispatchEvent(ev, { asOf, send: true, force: true });
  await dispatch.dispatchEvent(ev, { asOf, send: true, force: true });
  await dispatch.dispatchEvent(ev, { asOf, send: true, force: true });
  assert.equal(sendCount, 1, 'the same fact pushes once no matter how many times it is dispatched');
  assert.equal(await deliveredCount('ZZatomicIdem'), 1, 'exactly one delivered row survives repeated dispatch');
});
