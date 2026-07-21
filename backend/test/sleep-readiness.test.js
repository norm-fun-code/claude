// Unit coverage for the authoritative morning sleep-readiness state machine.
//
// The product rule: when Eight Sleep is configured, NEVER build/push the morning
// brief until the night's tracking is genuinely finalized. A late or missed
// brief beats an early one that wakes the user. These tests pin every failure
// mode of the old logic that this gate exists to close:
//   - a nonzero PROVISIONAL score while tracking continues must not build
//   - `/intervals/present` null is NOT proof of completion on its own
//   - a just-ended session (recent presenceEnd) must wait
//   - a single finalized observation is not "stable"
//   - two stable observations past the 10-min floor are NOT yet wake-confirmed
//   - only a continuously-inactive, unchanged fingerprint held past the
//     wake-confirmation window (default 30 min) is genuinely ready
//   - returning to bed resets stability (and wake confirmation) to zero
//   - an active interval always vetoes
//   - any API error fails CLOSED (no build)
//   - a process restart cannot turn one observation into a false "stable"
//   - yesterday's state cannot satisfy today
const test = require('node:test');
const assert = require('node:assert/strict');
const { getMorningSleepReadiness } = require('../src/intelligence/sleep-readiness');

const TZ = 'America/New_York';
const MIN = 60 * 1000;
// Deterministic thresholds for tests: 2 observations, 10-minute stability
// floor, 30-minute wake-CONFIRMATION window (production default — see
// sleep-readiness.js's thresholds()), 12-minute presenceEnd age. Using the
// real production default for wakeConfirmationMinMs (not a scaled-down test
// value) is deliberate: these are pure logic tests with injected timestamps,
// not real waits, so there's no cost to it, and it keeps the tests honest
// about what production actually requires.
const CFG = { minObservations: 2, minStabilityMs: 10 * MIN, wakeConfirmationMinMs: 30 * MIN, telemetryMinAgeMs: 12 * MIN };

// A fixed "morning" instant: 8:00 AM EDT on 2026-07-14 == 12:00 UTC.
const T0 = new Date('2026-07-14T12:00:00.000Z');
const TODAY = T0.toLocaleDateString('en-CA', { timeZone: TZ }); // '2026-07-14'
const at = (msFromT0) => new Date(T0.getTime() + msFromT0);

/** A finalized, wake-dated trend day. presenceEnd defaults to well in the past
 *  so the telemetry-age gate passes unless a test overrides it. */
function finalizedDay(over = {}) {
  return {
    day: TODAY,
    score: 82,
    sleepDuration: 7.5 * 3600,
    presenceDuration: 8 * 3600,
    deepDuration: 1.6 * 3600,
    remDuration: 1.8 * 3600,
    lightDuration: 4.1 * 3600,
    sleepQualityScore: { hrv: { current: 60 }, heartRate: { current: 52 }, respiratoryRate: { current: 14 } },
    presenceEnd: new Date(T0.getTime() - 40 * MIN).toISOString(),
    ...over,
  };
}

/** Build injectable deps with an in-memory durable state holder. */
function mkDeps({ present = false, days = [], throwOn = {}, initialState = null } = {}) {
  const holder = { state: initialState };
  return {
    holder,
    deps: {
      getCreds: async () => {
        if (throwOn.creds) throw new Error('creds boom');
        return { token: 't', userId: 'u' };
      },
      getIntervalPresent: async () => {
        if (throwOn.present) throw new Error('present boom');
        return present;
      },
      getTrends: async () => {
        if (throwOn.trends) throw new Error('trends boom');
        return days;
      },
      loadState: async () => holder.state,
      saveState: async (s) => { holder.state = s; },
    },
  };
}

const call = (deps, asOf, over = {}) =>
  getMorningSleepReadiness({ asOf, trigger: 'test', tz: TZ, deps, config: CFG, ...over });

test('active interval always vetoes — even with a nonzero provisional score present', async () => {
  const { deps } = mkDeps({ present: true, days: [finalizedDay({ score: 55 })] });
  const r = await call(deps, T0);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'session_active');
  assert.equal(r.evidence.presence, 'active');
});

test('present null but no finalized trend (only a provisional in-progress night) → no build', async () => {
  // score 0 / no sleepDuration == not a finalized night.
  const { deps } = mkDeps({ present: false, days: [{ day: TODAY, score: 0 }] });
  const r = await call(deps, T0);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'no_finalized_trend');
  assert.equal(r.evidence.presence, 'inactive');
});

test('a provisional score whose durations keep growing never becomes stable across polls', async () => {
  // Two polls, present inactive, but the night is still being written (duration
  // grows), so the fingerprint changes and stability never accrues.
  const { deps, holder } = mkDeps({ present: false, days: [finalizedDay({ sleepDuration: 6 * 3600 })] });
  const r1 = await call(deps, T0);
  assert.equal(r1.ready, false);
  assert.equal(r1.evidence.observations, 1);
  // Next poll 11 min later, but duration advanced → new fingerprint → reset to 1.
  deps.getTrends = async () => [finalizedDay({ sleepDuration: 6.2 * 3600 })];
  const r2 = await call(deps, at(11 * MIN));
  assert.equal(r2.ready, false);
  assert.equal(r2.reason, 'insufficient_stability');
  assert.equal(r2.evidence.observations, 1, 'a changed fingerprint restarts the stability count');
  assert.equal(holder.state.observations, 1);
});

test('only one finalized observation → no build (insufficient_stability)', async () => {
  const { deps } = mkDeps({ present: false, days: [finalizedDay()] });
  const r = await call(deps, T0);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'insufficient_stability');
  assert.equal(r.evidence.observations, 1);
});

test('presenceEnd populated but telemetry too recent → no build', async () => {
  const recent = { presenceEnd: new Date(T0.getTime() - 2 * MIN).toISOString() };
  const { deps } = mkDeps({ present: false, days: [finalizedDay(recent)] });
  // First observation.
  await call(deps, T0);
  // Second identical observation 11 min later — stable enough by count/time, but
  // presenceEnd is now only ~13 min... still, override to keep it recent.
  deps.getTrends = async () => [finalizedDay({ presenceEnd: new Date(at(11 * MIN).getTime() - 2 * MIN).toISOString() })];
  const r = await call(deps, at(11 * MIN));
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'telemetry_too_recent');
});

test('two observations past the 10-min stability floor are stable but NOT yet wake-confirmed', async () => {
  // This is the exact case that used to read "ready" and is the production bug:
  // ten-odd minutes of inactive/stable telemetry is only a floor, not proof the
  // night — as opposed to a bathroom trip or a provisional trend briefly holding
  // still — is actually over.
  const { deps, holder } = mkDeps({ present: false, days: [finalizedDay()] });
  const r1 = await call(deps, T0);
  assert.equal(r1.ready, false);
  assert.equal(r1.evidence.observations, 1);
  // Same fingerprint, 11 minutes later (> 10-min stability window, < 30-min
  // wake-confirmation window).
  const r2 = await call(deps, at(11 * MIN));
  assert.equal(r2.ready, false, 'stability alone must not be treated as wake completion');
  assert.equal(r2.reason, 'wake_not_confirmed');
  assert.equal(r2.evidence.observations, 2);
  assert.ok(r2.evidence.stableForMs >= CFG.minStabilityMs);
  assert.ok(r2.evidence.stableForMs < CFG.wakeConfirmationMinMs);
  assert.equal(r2.evidence.wakeConfirmed, false);
  assert.equal(holder.state.observations, 2);
});

test('a genuinely finalized, continuously inactive night eventually becomes READY once wake-confirmed', async () => {
  const { deps, holder } = mkDeps({ present: false, days: [finalizedDay()] });
  await call(deps, T0); // obs 1
  const r2 = await call(deps, at(11 * MIN)); // obs 2, stable but not yet wake-confirmed
  assert.equal(r2.ready, false);
  assert.equal(r2.reason, 'wake_not_confirmed');
  // Same fingerprint continues to hold, now past the 30-min wake-confirmation window.
  const r3 = await call(deps, at(31 * MIN));
  assert.equal(r3.ready, true);
  assert.equal(r3.reason, 'ready');
  assert.equal(r3.evidence.wakeConfirmed, true);
  assert.ok(r3.evidence.stableForMs >= CFG.wakeConfirmationMinMs);
  assert.ok(r3.evidence.telemetryAgeMs >= CFG.telemetryMinAgeMs);
  assert.equal(holder.state.observations, 3);
});

test('inactive → stable → active again never builds or pushes, even after the wake-confirmation window would otherwise have elapsed', async () => {
  const { deps, holder } = mkDeps({ present: false, days: [finalizedDay()] });
  await call(deps, T0); // obs 1
  await call(deps, at(11 * MIN)); // obs 2, stable-but-not-confirmed
  // User gets back into bed right before the window would have closed.
  deps.getIntervalPresent = async () => true;
  const rBed = await call(deps, at(25 * MIN));
  assert.equal(rBed.ready, false);
  assert.equal(rBed.reason, 'session_active');
  assert.equal(holder.state.observations, 0, 'wake confirmation is wiped, not just paused');
  // Even well past where the original window would have elapsed, going inactive
  // again restarts the count from scratch — it cannot fast-forward to ready.
  deps.getIntervalPresent = async () => false;
  const rOut = await call(deps, at(35 * MIN));
  assert.equal(rOut.ready, false);
  assert.equal(rOut.evidence.observations, 1);
});

test('two identical observations too CLOSE together are not yet stable (needs the min window)', async () => {
  const { deps } = mkDeps({ present: false, days: [finalizedDay()] });
  await call(deps, T0);
  // Only 3 minutes later — obs count is 2 but the window isn't satisfied.
  const r = await call(deps, at(3 * MIN));
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'insufficient_stability');
  assert.equal(r.evidence.observations, 2);
});

test('returning to bed (present goes active) resets accumulated stability', async () => {
  const { deps, holder } = mkDeps({ present: false, days: [finalizedDay()] });
  await call(deps, T0); // obs 1
  // User climbs back into bed — present now active.
  deps.getIntervalPresent = async () => true;
  const rBed = await call(deps, at(5 * MIN));
  assert.equal(rBed.ready, false);
  assert.equal(rBed.reason, 'session_active');
  assert.equal(holder.state.observations, 0, 'stability wiped on bed re-entry');
  // Back out of bed; the SAME finalized snapshot now starts counting from scratch.
  deps.getIntervalPresent = async () => false;
  const rOut = await call(deps, at(10 * MIN));
  assert.equal(rOut.evidence.observations, 1, 'count restarts at 1 after a reset');
  assert.equal(rOut.ready, false);
});

test('a fresh biometric sample (new fingerprint) resets stability', async () => {
  const { deps } = mkDeps({ present: false, days: [finalizedDay()] });
  await call(deps, T0); // obs 1
  // A new HRV sample lands — fingerprint changes → back to obs 1.
  deps.getTrends = async () => [finalizedDay({ sleepQualityScore: { hrv: { current: 61 } } })];
  const r = await call(deps, at(11 * MIN));
  assert.equal(r.evidence.observations, 1);
  assert.equal(r.ready, false);
});

test('credential fetch failure fails CLOSED', async () => {
  const { deps } = mkDeps({ throwOn: { creds: true } });
  const r = await call(deps, T0);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'credentials_failed');
});

test('present-check API error fails CLOSED (does not read as "session ended")', async () => {
  const { deps } = mkDeps({ throwOn: { present: true }, days: [finalizedDay()] });
  const r = await call(deps, T0);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'present_check_failed');
});

test('trends fetch error / 404 ambiguity / malformed response fails CLOSED', async () => {
  const { deps } = mkDeps({ present: false, throwOn: { trends: true } });
  const r = await call(deps, T0);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'trends_fetch_failed');
});

test('an API error must not advance stability (a blip cannot count as an observation)', async () => {
  const { deps, holder } = mkDeps({ present: false, days: [finalizedDay()] });
  await call(deps, T0); // obs 1 persisted
  // A transient trends outage on the next poll.
  const failing = { ...deps, getTrends: async () => { throw new Error('boom'); } };
  const rFail = await call(failing, at(11 * MIN));
  assert.equal(rFail.ready, false);
  assert.equal(holder.state.observations, 1, 'the failed poll left the persisted count untouched');
  // Recovery poll with the same fingerprint, now past the wake-confirmation window.
  const rOk = await call(deps, at(31 * MIN));
  assert.equal(rOk.evidence.observations, 2);
  assert.equal(rOk.ready, true);
});

test('a process restart does NOT turn one persisted observation into a false "stable" state', async () => {
  // Simulate: obs 1 persisted before the restart.
  const persisted = { day: TODAY, fingerprint: null, observations: 0, firstStableAt: null };
  const { deps, holder } = mkDeps({ present: false, days: [finalizedDay()], initialState: persisted });
  const r1 = await call(deps, T0); // obs 1, firstStableAt = T0
  assert.equal(r1.evidence.observations, 1);
  // "Restart": a brand-new deps object reading the SAME persisted holder state.
  const afterRestart = mkDeps({ present: false, days: [finalizedDay()], initialState: holder.state });
  // Immediately after restart (only 1 min later) → obs 2 but window NOT satisfied.
  const rSoon = await call(afterRestart.deps, at(1 * MIN));
  assert.equal(rSoon.evidence.observations, 2);
  assert.equal(rSoon.ready, false, 'two obs but < min stability window is still not ready');
  assert.equal(rSoon.reason, 'insufficient_stability');
  // Past the 10-min floor but still short of wake confirmation.
  const rStable = await call(afterRestart.deps, at(11 * MIN));
  assert.equal(rStable.ready, false);
  assert.equal(rStable.reason, 'wake_not_confirmed');
  // Only once the genuine wake-confirmation window has also elapsed does it become ready.
  const rLater = await call(afterRestart.deps, at(31 * MIN));
  assert.equal(rLater.ready, true);
});

test("yesterday's stable state cannot satisfy today's readiness", async () => {
  const yesterday = new Date(T0.getTime() - 24 * 60 * MIN).toLocaleDateString('en-CA', { timeZone: TZ });
  const staleStable = { day: yesterday, fingerprint: 'whatever', observations: 9, firstStableAt: T0.getTime() - 24 * 60 * MIN };
  const { deps } = mkDeps({ present: false, days: [finalizedDay()], initialState: staleStable });
  const r = await call(deps, T0);
  assert.equal(r.ready, false, "a prior day's 9 observations must not carry into today");
  assert.equal(r.evidence.observations, 1);
  assert.equal(r.reason, 'insufficient_stability');
});

test('a trend for a DIFFERENT day (no today row) is not a finalized trend for today', async () => {
  const otherDay = finalizedDay({ day: '2026-07-13' });
  const { deps } = mkDeps({ present: false, days: [otherDay] });
  const r = await call(deps, T0);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'no_finalized_trend');
});

test('readiness never throws — returns a structured not-ready even on total failure', async () => {
  const deps = {
    getCreds: async () => ({ token: 't', userId: 'u' }),
    getIntervalPresent: async () => { throw new Error('x'); },
    getTrends: async () => { throw new Error('y'); },
    loadState: async () => { throw new Error('z'); },
    saveState: async () => { throw new Error('w'); },
  };
  const r = await call(deps, T0);
  assert.equal(r.ready, false);
  assert.ok(typeof r.reason === 'string');
});
