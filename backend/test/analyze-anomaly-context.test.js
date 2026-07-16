// Integration-level coverage for analyze.js's anomaly/life-context
// attachment pipeline (resolveNightWindow + annotateAnomaliesWithContext) —
// both are pure and exported specifically so this doesn't need a live DB.
// See context-semantics.test.js for the underlying classification rules;
// this file exercises the FULL pipeline the way analyze() actually calls it,
// including the exact production bug: a retraction attached to a resting-HR
// anomaly as a possible cause.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveNightWindow, annotateAnomaliesWithContext } = require('../src/intelligence/analyze');

const TZ = 'America/New_York';

function rhrAnomaly(detail = 'Resting HR is 60.2 today vs your baseline of 54.1.') {
  return {
    type: 'anomaly',
    title: 'Resting HR well above your usual',
    detail,
    evidence: { auto: true, kind: 'anomaly', metric: 'health:resting_hr' },
  };
}

test('resolveNightWindow: uses the measured wake_time reading when available', () => {
  const wakeTimeSeries = [{ day: '2026-06-11', value: 6.5 }]; // 6:30am
  const { start, end } = resolveNightWindow('2026-06-11', wakeTimeSeries, TZ);
  assert.ok(start < end);
  // End should be ~6:30am ET on 2026-06-11.
  const endLocal = end.toLocaleString('en-US', { timeZone: TZ, hour12: false });
  assert.match(endLocal, /06:30/);
});

test('resolveNightWindow: falls back to a generous default wake hour with no reading', () => {
  const { start, end } = resolveNightWindow('2026-06-11', [], TZ);
  assert.ok(start < end);
  const endLocal = end.toLocaleString('en-US', { timeZone: TZ, hour12: false });
  assert.match(endLocal, /11:00/);
});

test('the exact screenshot sentence attached to health: excluded, never appears in the finding detail', () => {
  const anomalies = [rhrAnomaly()];
  const annotations = [{
    label: "I didnt end up going for drinks with friends tonight. Please forget that context.",
    category: 'brief_context',
    start_ts: new Date().toISOString(),
  }];
  annotateAnomaliesWithContext(anomalies, annotations, {
    todayDayKey: new Date().toLocaleDateString('en-CA', { timeZone: TZ }),
    tz: TZ,
    wakeTimeSeries: [],
  });
  assert.doesNotMatch(anomalies[0].detail, /forget/i);
  assert.doesNotMatch(anomalies[0].detail, /Context:/);
  assert.doesNotMatch(anomalies[0].detail, /may explain/i);
});

test('"I didnt end up going...please forget that context" is treated as a retraction, never causal', () => {
  const anomalies = [rhrAnomaly()];
  const annotations = [{
    label: "I didnt end up going for drinks with friends tonight. Please forget that context.",
    category: 'brief_context',
    start_ts: new Date().toISOString(),
  }];
  const before = anomalies[0].detail;
  annotateAnomaliesWithContext(anomalies, annotations, {
    todayDayKey: new Date().toLocaleDateString('en-CA', { timeZone: TZ }),
    tz: TZ,
  });
  assert.equal(anomalies[0].detail, before, 'detail must be unchanged — no context appended at all');
});

test('"Had 3 drinks last night" is eligible for next-morning RHR/HRV and uses "Possible contributor" phrasing', () => {
  const todayDayKey = '2026-06-11';
  const anomalies = [rhrAnomaly()];
  const annotations = [{
    label: 'Had 3 drinks last night',
    category: 'brief_context',
    start_ts: '2026-06-11T09:00:00.000Z', // logged the morning after, explicit backward reference
  }];
  annotateAnomaliesWithContext(anomalies, annotations, { todayDayKey, tz: TZ, wakeTimeSeries: [] });
  assert.match(anomalies[0].detail, /Possible contributor:/);
  assert.match(anomalies[0].detail, /Had 3 drinks last night/);
  assert.doesNotMatch(anomalies[0].detail, /may explain this deviation/);
});

test('"I did not drink last night" is not an adverse causal explanation', () => {
  const todayDayKey = '2026-06-11';
  const anomalies = [rhrAnomaly()];
  const annotations = [{
    label: 'I did not drink last night',
    category: 'brief_context',
    start_ts: '2026-06-11T09:00:00.000Z',
  }];
  const before = anomalies[0].detail;
  annotateAnomaliesWithContext(anomalies, annotations, { todayDayKey, tz: TZ, wakeTimeSeries: [] });
  assert.equal(anomalies[0].detail, before);
});

test('"Planning drinks tonight" cannot explain last night\'s already-collected data', () => {
  const todayDayKey = '2026-06-11';
  const anomalies = [rhrAnomaly()];
  const annotations = [{
    label: 'Planning drinks tonight',
    category: 'brief_context',
    start_ts: '2026-06-11T14:00:00.000Z', // logged today, forward-looking
  }];
  const before = anomalies[0].detail;
  annotateAnomaliesWithContext(anomalies, annotations, { todayDayKey, tz: TZ, wakeTimeSeries: [] });
  assert.equal(anomalies[0].detail, before);
});

test('"Room was very hot last night" is eligible for sleep/RHR', () => {
  const todayDayKey = '2026-06-11';
  const anomalies = [{
    type: 'anomaly', title: 'Sleep score below your usual', detail: 'Sleep score is 62 today vs your baseline of 78.',
    evidence: { auto: true, kind: 'anomaly', metric: 'health:sleep_score' },
  }];
  const annotations = [{
    label: 'Room was very hot last night, could not cool down',
    category: 'brief_context',
    start_ts: '2026-06-10T22:00:00.000Z',
  }];
  annotateAnomaliesWithContext(anomalies, annotations, { todayDayKey, tz: TZ, wakeTimeSeries: [] });
  assert.match(anomalies[0].detail, /Possible contributor:.*hot/);
});

test('ongoing illness is eligible only during its active window', () => {
  const todayDayKey = '2026-06-11';
  const activeIllness = [{ label: 'Still sick with a cold', category: 'illness', start_ts: '2026-06-09T12:00:00.000Z', end_ts: '2026-06-12T12:00:00.000Z' }];
  const resolvedIllness = [{ label: 'Still sick with a cold', category: 'illness', start_ts: '2026-05-01T12:00:00.000Z', end_ts: '2026-05-04T12:00:00.000Z' }];

  const a1 = [rhrAnomaly()];
  annotateAnomaliesWithContext(a1, activeIllness, { todayDayKey, tz: TZ, wakeTimeSeries: [] });
  assert.match(a1[0].detail, /Possible contributor:.*sick/);

  const a2 = [rhrAnomaly()];
  const before = a2[0].detail;
  annotateAnomaliesWithContext(a2, resolvedIllness, { todayDayKey, tz: TZ, wakeTimeSeries: [] });
  assert.equal(a2[0].detail, before, 'a resolved illness from weeks ago should not attach');
});

test('two-day-old expired context is excluded', () => {
  const todayDayKey = '2026-06-11';
  const anomalies = [rhrAnomaly()];
  const annotations = [{
    label: 'Had a few drinks with friends',
    category: 'brief_context',
    start_ts: '2026-06-08T22:00:00.000Z', // two nights before
  }];
  const before = anomalies[0].detail;
  annotateAnomaliesWithContext(anomalies, annotations, { todayDayKey, tz: TZ, wakeTimeSeries: [] });
  assert.equal(anomalies[0].detail, before);
});

test('same-day unrelated context (no backward reference) is excluded', () => {
  const todayDayKey = '2026-06-11';
  const anomalies = [rhrAnomaly()];
  const annotations = [{
    // 2pm ET on 2026-06-11 — well after the default 11am ET wake fallback,
    // so this is squarely "later today", not "last night", and carries no
    // backward reference ("last night"/"yesterday"/"overnight").
    label: 'Feeling stressed about a deadline today',
    category: 'brief_context',
    start_ts: '2026-06-11T18:00:00.000Z',
  }];
  const before = anomalies[0].detail;
  annotateAnomaliesWithContext(anomalies, annotations, { todayDayKey, tz: TZ, wakeTimeSeries: [] });
  assert.equal(anomalies[0].detail, before);
});

test('financial context remains excluded from health', () => {
  const todayDayKey = '2026-06-11';
  const anomalies = [rhrAnomaly()];
  const annotations = [{
    label: 'Spent $665 on vacation flights',
    category: 'brief_context',
    start_ts: '2026-06-11T09:00:00.000Z',
  }];
  const before = anomalies[0].detail;
  annotateAnomaliesWithContext(anomalies, annotations, { todayDayKey, tz: TZ, wakeTimeSeries: [] });
  assert.equal(anomalies[0].detail, before);
});

test('retired/superseded context is excluded even when otherwise eligible', () => {
  const todayDayKey = '2026-06-11';
  const anomalies = [rhrAnomaly()];
  const annotations = [{
    label: 'Had 3 drinks last night',
    category: 'brief_context',
    start_ts: '2026-06-11T09:00:00.000Z',
    retired_at: '2026-06-11T10:00:00.000Z',
  }];
  const before = anomalies[0].detail;
  annotateAnomaliesWithContext(anomalies, annotations, { todayDayKey, tz: TZ, wakeTimeSeries: [] });
  assert.equal(anomalies[0].detail, before);
});

test('multiple eligible annotations across different anomalies are attached independently', () => {
  const todayDayKey = '2026-06-11';
  const anomalies = [
    rhrAnomaly('Resting HR is 60.2 today vs your baseline of 54.1.'),
    { type: 'anomaly', title: 'Steps well below your usual', detail: 'Steps are 1200 today vs your baseline of 8000.', evidence: { auto: true, kind: 'anomaly', metric: 'health:steps' } },
  ];
  const annotations = [{ label: 'Had 3 drinks last night', category: 'brief_context', start_ts: '2026-06-11T09:00:00.000Z' }];
  annotateAnomaliesWithContext(anomalies, annotations, { todayDayKey, tz: TZ, wakeTimeSeries: [] });
  assert.match(anomalies[0].detail, /Possible contributor/);
  // steps is not a SLEEP_BODY_METRIC or WELLBEING_METRIC — never gets context.
  assert.doesNotMatch(anomalies[1].detail, /Possible contributor/);
});
