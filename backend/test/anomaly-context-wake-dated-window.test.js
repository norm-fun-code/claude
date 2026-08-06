// Reported bug (Aug 6 2026): the user told Ask on the EVENING OF AUG 5 that
// they'd had a boys night and drank a lot. The next morning the app still
// asked "Anything unusual about Thursday, August 6 that might help explain
// this?" about a resting-HR spike — a question it had already been answered.
//
// Resting HR (like HRV, sleep stages, respiratory rate — analyze.js's
// NIGHT_METRICS) is WAKE-DATED: the value stamped Aug 6 describes the night
// of Aug 5. But the "do we already have an explanation?" overlap search used
// only the observation day's local bounds (Aug 6 00:00 -> 23:59), so an
// assertion recorded at ~10pm on Aug 5 fell outside it and the question was
// asked anyway. The window must reach back over the night that produced the
// reading.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { explanatoryBoundsFor, isWakeDatedMetric, isEligibleForQuestion } = require('../src/intelligence/anomalyContext');

const TZ = 'America/New_York';
// 10pm ET on Aug 5 — when the user actually told Ask about the boys night.
const BOYS_NIGHT = new Date('2026-08-06T02:00:00Z');

test('required: resting HR is treated as wake-dated; a same-day metric like mood is not', () => {
  assert.equal(isWakeDatedMetric('health:resting_hr'), true);
  assert.equal(isWakeDatedMetric('health:hrv'), true);
  assert.equal(isWakeDatedMetric('health:sleep_hours'), true);
  assert.equal(isWakeDatedMetric('wellbeing:mood'), false);
  assert.equal(isWakeDatedMetric(null), false);
});

test('required: a wake-dated anomaly\'s explanatory window covers the PRECEDING night — the exact reported case', () => {
  const bounds = explanatoryBoundsFor({ metric: 'health:resting_hr', date: '2026-08-06' }, TZ);
  assert.ok(
    BOYS_NIGHT >= bounds.start && BOYS_NIGHT <= bounds.end,
    'an explanation given the evening before must count as already covering the morning reading'
  );
  // Starts at local midnight of the PREVIOUS day, still ends at the
  // observation day's end.
  assert.equal(bounds.start.toISOString(), '2026-08-05T04:00:00.000Z');
  assert.equal(bounds.end.toISOString(), '2026-08-07T03:59:59.999Z');
});

test('required: a non-wake-dated metric keeps the observation-day-only window (unchanged)', () => {
  const bounds = explanatoryBoundsFor({ metric: 'wellbeing:mood', date: '2026-08-06' }, TZ);
  assert.equal(bounds.start.toISOString(), '2026-08-06T04:00:00.000Z');
  assert.equal(bounds.end.toISOString(), '2026-08-07T03:59:59.999Z');
  assert.ok(BOYS_NIGHT < bounds.start, 'the previous evening is correctly NOT folded into a same-day metric');
});

test('required: the widened window is DST-safe (derived in-tz, never by subtracting 24h)', () => {
  // Nov 1 2026 is the US fall-back day (25h local day). Deriving the previous
  // day by subtracting 24h from local midnight would land on the wrong date.
  const bounds = explanatoryBoundsFor({ metric: 'health:resting_hr', date: '2026-11-02' }, TZ);
  assert.equal(bounds.start.toISOString(), '2026-11-01T04:00:00.000Z', 'must be Nov 1 local midnight (EDT, UTC-4)');
});

test('required: with the preceding-night explanation found, the question is no longer asked', () => {
  const evidence = { kind: 'anomaly', anomalyKey: 'anomaly:health:resting_hr:2026-08-06', metric: 'health:resting_hr', date: '2026-08-06', domains: ['health'] };
  const asOf = new Date('2026-08-06T14:00:00Z');
  const askedWithout = isEligibleForQuestion({ evidence, row: null, overlappingAssertions: [], tz: TZ, asOf });
  const askedWith = isEligibleForQuestion({
    evidence, row: null,
    overlappingAssertions: [{ id: 'a1', domains: ['health'] }], // the boys-night assertion the widened window now finds
    tz: TZ, asOf,
  });
  assert.equal(askedWithout, true, 'with no explanation on record it should still ask');
  assert.equal(askedWith, false, 'an existing explanation must suppress the question');
});
