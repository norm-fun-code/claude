const test = require('node:test');
const assert = require('node:assert/strict');
const { predictCapacity, sleepDebtTrajectory, parseContextAdjustment, applyContextToForecast, forecastTomorrow } = require('../src/intelligence/predict');

test('high recovery → A day, full send', () => {
  const r = predictCapacity({ recoveryScore: 80, hrvSubScore: 70 });
  assert.equal(r.grade, 'A');
  assert.equal(r.band, 'green');
  assert.match(r.prescription, /full stack|bank progress/i);
});

test('mid recovery → B day, essentials', () => {
  const r = predictCapacity({ recoveryScore: 58 });
  assert.equal(r.grade, 'B');
  assert.equal(r.band, 'yellow');
  assert.match(r.prescription, /essentials|consistency/i);
});

test('low recovery → C day, anything that compounds above zero', () => {
  const r = predictCapacity({ recoveryScore: 30, hrvSubScore: 25, sleepHours: 5.5 });
  assert.equal(r.grade, 'C');
  assert.equal(r.band, 'red');
  // The C-day philosophy: not zero — a walk, a meditation, one habit.
  assert.match(r.prescription, /zero/i);
  assert.match(r.prescription, /walk|meditation|habit/i);
  // Drivers are named.
  assert.match(r.detail, /HRV is down/i);
});

test('boundary: 63 is an A, 62 is a B, 40 is a B, 39 is a C', () => {
  assert.equal(predictCapacity({ recoveryScore: 63 }).grade, 'A');
  assert.equal(predictCapacity({ recoveryScore: 62 }).grade, 'B');
  assert.equal(predictCapacity({ recoveryScore: 40 }).grade, 'B');
  assert.equal(predictCapacity({ recoveryScore: 39 }).grade, 'C');
});

test('null/invalid recovery score → no forecast', () => {
  assert.equal(predictCapacity({ recoveryScore: null }), null);
  assert.equal(predictCapacity({}), null);
  assert.equal(predictCapacity({ recoveryScore: NaN }), null);
});

test('A day with spiking load gets a smart-intensity caution', () => {
  const r = predictCapacity({ recoveryScore: 75, acwrBand: 'high' });
  assert.match(r.prescription, /spiking|intensity/i);
});

test('sleep-debt trajectory: names hours, weekday, and the HRV lag', () => {
  const asOf = new Date('2026-06-14T12:00:00Z'); // a Sunday
  const t = sleepDebtTrajectory({ debtHours: 1.6, needHours: 7.87, asOf });
  assert.equal(t.debtHours, 1.6);
  assert.equal(t.nights, 2);
  assert.match(t.detail, /1h 36m in sleep debt/);
  assert.match(t.detail, /7h 52m need/);
  assert.match(t.detail, /HRV/);
});

test('negligible sleep debt (< 1h) returns null — no nagging', () => {
  assert.equal(sleepDebtTrajectory({ debtHours: 0.4, needHours: 8 }), null);
  assert.equal(sleepDebtTrajectory({ debtHours: null }), null);
});

test('large debt switches from "by weekday" to "about N nights"', () => {
  const t = sleepDebtTrajectory({ debtHours: 6, needHours: 8 });
  assert.equal(t.nights, 6);
  assert.match(t.detail, /about 6 solid nights/i);
});

// ── Context-adjusted forecast ─────────────────────────────────────────────────

test('parseContextAdjustment: relevant + downgrade extracts cleanly', () => {
  const a = parseContextAdjustment('{"relevant":true,"downgrade":true,"note":"Big presentation tomorrow adds stress"}');
  assert.deepEqual(a, { downgrade: true, note: 'Big presentation tomorrow adds stress' });
});

test('parseContextAdjustment: relevant but no downgrade (note only)', () => {
  const a = parseContextAdjustment('{"relevant":true,"downgrade":false,"note":"Traveling tomorrow"}');
  assert.deepEqual(a, { downgrade: false, note: 'Traveling tomorrow' });
});

test('parseContextAdjustment: not relevant → null (no adjustment)', () => {
  assert.equal(parseContextAdjustment('{"relevant":false,"downgrade":false,"note":""}'), null);
});

test('parseContextAdjustment: malformed / missing / non-JSON → null', () => {
  assert.equal(parseContextAdjustment(''), null);
  assert.equal(parseContextAdjustment('not json'), null);
  assert.equal(parseContextAdjustment('{"downgrade":true}'), null); // relevant missing
});

test('applyContextToForecast: no context at all → untouched, no LLM call', async () => {
  const base = { band: 'yellow', projectedScore: 55, detail: 'x', lever: 'y', confidence: 60 };
  const out = await applyContextToForecast(base, { dayContext: [], annotations: [] });
  assert.equal(out, base); // same reference — proves it short-circuited before any LLM call
});

test('applyContextToForecast: null forecast passes through unchanged', async () => {
  assert.equal(await applyContextToForecast(null, { dayContext: [{ text: 'x' }] }), null);
});

// ── forecastTomorrow: hardSessionStatus wording ─────────────────────────────
// Bug: computeTodayForecast() used to infer "today's hard session" from
// elevated active_energy without proving the row was actually today, and with
// no notion of "planned but not yet completed" vs "explicitly done". These
// tests pin forecastTomorrow's contract for the three states the fix produces.

test('hardSessionStatus "none" (rest/recovery/zone2 day): no hard-session drag', () => {
  const t = forecastTomorrow({ recoveryScore: 70, hardSessionStatus: 'none' });
  assert.doesNotMatch(t.detail, /hard session/i);
});

test('hardSessionStatus "completed": drags with COMPLETED wording, not planned wording', () => {
  const t = forecastTomorrow({ recoveryScore: 70, hardSessionStatus: 'completed' });
  assert.match(t.detail, /today's hard session adds fatigue/i);
  assert.doesNotMatch(t.detail, /planned hard session may add fatigue/i);
});

test('hardSessionStatus "planned": drags with PROVISIONAL wording, not asserted-fact wording', () => {
  const t = forecastTomorrow({ recoveryScore: 70, hardSessionStatus: 'planned' });
  assert.match(t.detail, /today's planned hard session may add fatigue/i);
  assert.doesNotMatch(t.detail, /today's hard session adds fatigue\b/i);
});

test('an unspecified hardSessionStatus defaults to "none" (no drag)', () => {
  const t = forecastTomorrow({ recoveryScore: 70 });
  assert.doesNotMatch(t.detail, /hard session/i);
});

test('"planned" and "completed" apply the same numeric fatigue penalty', () => {
  const planned = forecastTomorrow({ recoveryScore: 70, hardSessionStatus: 'planned' });
  const completed = forecastTomorrow({ recoveryScore: 70, hardSessionStatus: 'completed' });
  assert.equal(planned.projectedScore, completed.projectedScore);
});

test('a low-load easy day (hardSessionStatus none, no other drags) gets the easy-day bump', () => {
  const t = forecastTomorrow({ recoveryScore: 70, hardSessionStatus: 'none', acwrBand: 'low', sleepDebtHours: 0 });
  assert.equal(t.projectedScore, 74); // 70 + 4 easy bump, no drags
  assert.doesNotMatch(t.detail, /hard session/i);
});
