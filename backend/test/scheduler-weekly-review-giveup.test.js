// Aug 2 2026 incident: the wake-aware weekly-review watcher (scheduler.js's
// startMorningWatcher tick) gated firing on Eight Sleep wake-readiness with
// NO give-up fallback, unlike the daily morning brief right below it. On a
// day with zero Eight Sleep observations (no ring reading at all), readiness
// never confirms, so the week's one review silently never generated all day.
// shouldRunWeeklyReview is the extracted pure decision — these tests pin the
// exact behavior that closes that gap.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldRunWeeklyReview } = require('../src/scheduler');

test('required: does not fire while wake-readiness is unconfirmed and still before the give-up cutoff', () => {
  assert.equal(shouldRunWeeklyReview({ readinessReady: false, pastGiveup: false }), false);
});

test('required: fires the moment wake-readiness confirms, even before the give-up cutoff', () => {
  assert.equal(shouldRunWeeklyReview({ readinessReady: true, pastGiveup: false }), true);
});

test('required: fires past the give-up cutoff even when readiness never confirmed — the exact incident fixed', () => {
  assert.equal(shouldRunWeeklyReview({ readinessReady: false, pastGiveup: true }), true);
});

test('required: still fires past the give-up cutoff if readiness happens to be confirmed too', () => {
  assert.equal(shouldRunWeeklyReview({ readinessReady: true, pastGiveup: true }), true);
});
