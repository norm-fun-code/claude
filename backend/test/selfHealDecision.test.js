// Required regression coverage for the wake-aware self-heal decision (July
// 30 2026 incident hardening, section 3) — routes/briefing.js's
// selfHealDecision replaces the old pure-clock pastMorningCutoff gate with
// one that derives eligibility from Eight Sleep wake-readiness when
// configured, closing the exact gap that let the self-healing GET ignore
// readiness entirely in wake-aware mode.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selfHealDecision } = require('../src/routes/briefing');

const TZ = 'America/New_York';

test('required: when Eight Sleep is not configured, self-heal falls back to the pure clock cutoff (unchanged legacy behavior)', async () => {
  const notConfigured = () => false;
  // Well past the default 08:30 + 30min grace cutoff.
  const late = new Date('2026-07-30T13:00:00Z'); // ~09:00 EDT
  const early = new Date('2026-07-30T09:00:00Z'); // ~05:00 EDT
  const lateDecision = await selfHealDecision(late, TZ, { eightSleepConfigured: notConfigured });
  const earlyDecision = await selfHealDecision(early, TZ, { eightSleepConfigured: notConfigured });
  assert.equal(lateDecision.shouldTrigger, true);
  assert.equal(lateDecision.waitingForSleepData, false);
  assert.equal(earlyDecision.shouldTrigger, false);
  assert.equal(earlyDecision.waitingForSleepData, false);
});

test('required: when Eight Sleep is configured and readiness is confirmed ready, self-heal is eligible immediately — no SCHEDULE_HOUR grace window', async () => {
  // A time that would NOT have passed the old pastMorningCutoff grace window
  // at all (well before 08:30+30min) — proves eligibility is driven ENTIRELY
  // by readiness now, not layered on top of the clock cutoff.
  const veryEarly = new Date('2026-07-30T10:41:00Z'); // 06:41 EDT
  const configured = () => true;
  const getMorningSleepReadiness = async () => ({
    ready: true, reason: 'ready_strong_evidence',
    evidence: { trigger: 'self_heal_check', evidenceTier: 'strong' },
  });
  const decision = await selfHealDecision(veryEarly, TZ, { eightSleepConfigured: configured, getMorningSleepReadiness });
  assert.equal(decision.shouldTrigger, true);
  assert.equal(decision.waitingForSleepData, false);
  assert.equal(decision.reason, 'ready_strong_evidence');
});

test('required: when Eight Sleep is configured and readiness is still pending, self-heal returns waiting_for_sleep_data with the real reason — never a silent no-op or a generic failure', async () => {
  const now = new Date('2026-07-30T11:10:00Z');
  const configured = () => true;
  const getMorningSleepReadiness = async () => ({
    ready: false, reason: 'insufficient_stability',
    evidence: { trigger: 'self_heal_check', evidenceTier: 'pending' },
  });
  const decision = await selfHealDecision(now, TZ, { eightSleepConfigured: configured, getMorningSleepReadiness });
  assert.equal(decision.shouldTrigger, false);
  assert.equal(decision.waitingForSleepData, true);
  assert.equal(decision.reason, 'insufficient_stability');
});

test('required: a readiness-check failure fails closed (waiting, not triggering) rather than guessing', async () => {
  const now = new Date('2026-07-30T12:00:00Z');
  const configured = () => true;
  const getMorningSleepReadiness = async () => { throw new Error('boom'); };
  const decision = await selfHealDecision(now, TZ, { eightSleepConfigured: configured, getMorningSleepReadiness });
  assert.equal(decision.shouldTrigger, false);
  assert.equal(decision.waitingForSleepData, true);
  assert.equal(decision.reason, 'readiness_error');
});
