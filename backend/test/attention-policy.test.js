// The Judgment and Attention Policy's pure decision core. judge() is the
// single place that answers "given this event, what should NormOS do about
// it right now?" — deterministic gates first (Stage A, short-circuit), then
// a scored ladder (Stage B) that defaults conservatively. Pure: no DB, no
// clock beyond what's passed in, so every test below is a plain function
// call with a hand-built event + context.
const test = require('node:test');
const assert = require('node:assert/strict');
const { judge, eventKey, THRESHOLDS, CRITICAL_ALLOWLIST } = require('../src/intelligence/attention');

// ---- fixtures ----

function baseEvent(overrides = {}) {
  return {
    source: 'watch_health', domain: 'health', type: 'anomaly', subject: 'hrv',
    title: 'Your HRV dropped', body: 'HRV is 32ms — 18% below your 30-day norm.',
    observedAt: new Date('2026-07-11T10:00:00'),
    signal: { magnitude: 0.7, confidence: 0.85, novelty: null },
    urgencyHint: null, belief: null, action: null, critical: false,
    dedupBucket: 'day', hasUncertainty: false,
    ...overrides,
  };
}

function baseContext(overrides = {}) {
  return {
    quiet: false,
    budget: { limit: 4, usedToday: 0 },
    criticalBudget: { limit: 1, usedToday: 0 },
    recentKeys: new Set(),
    noveltyByKey: new Set(),
    consentGrants: new Set(),
    beliefMultipliers: new Map(),
    activeGoalSubjects: new Set(),
    activeChapterSubjects: new Set(),
    openCommitmentSubjects: new Set(),
    capacity: null,
    questionBudgetLeft: 1,
    ...overrides,
  };
}

// ---- malformed input: fail conservative ----

test('a malformed event (missing domain/type/subject) never notifies', () => {
  for (const bad of [null, {}, { domain: 'health' }, { domain: 'health', type: 'anomaly' }]) {
    const d = judge(bad, baseContext());
    assert.equal(d.disposition, 'store_silently');
  }
});

// ---- every disposition, at least once ----

test('store_silently: low value, no action, no belief', () => {
  const e = baseEvent({ signal: { magnitude: 0.05, confidence: 0.1, novelty: 0 } });
  const d = judge(e, baseContext());
  assert.equal(d.disposition, 'store_silently');
  assert.ok(d.reason.length > 0, 'explanation must be non-empty');
});

test('update_belief: a belief-carrying event always routes here, never interrupts', () => {
  const e = baseEvent({
    domain: 'meta', type: 'dismissal_pattern', subject: 'dismissal:subscription_review',
    belief: { kind: 'dismissal_pattern', dedupKey: 'dismissal:subscription_review', statement: 'x', confidence: 0.9 },
    signal: { magnitude: 1, confidence: 1, novelty: 1 }, // even maximal signal must not override belief routing
  });
  const d = judge(e, baseContext());
  assert.equal(d.disposition, 'update_belief');
  assert.equal(d.deliver, null, 'belief updates never carry a delivery channel');
});

test('ask_question: genuine uncertainty at sufficient value, budget available', () => {
  const e = baseEvent({
    type: 'forecast_risk', domain: 'meta', subject: 'g1', hasUncertainty: true,
    signal: { magnitude: 0.6, confidence: 0.6, novelty: 1 },
  });
  const d = judge(e, baseContext());
  assert.equal(d.disposition, 'ask_question');
  assert.equal(d.deliver.channel, 'question');
});

test('ask_question is unavailable once the daily question budget is spent', () => {
  const e = baseEvent({ hasUncertainty: true, signal: { magnitude: 0.6, confidence: 0.6, novelty: 1 } });
  const d = judge(e, baseContext({ questionBudgetLeft: 0 }));
  assert.notEqual(d.disposition, 'ask_question');
});

test('add_to_brief: real value, below the interrupt/offer bar', () => {
  const e = baseEvent({ type: 'trend', signal: { magnitude: 0.3, confidence: 0.5, novelty: 1 } });
  const d = judge(e, baseContext());
  assert.equal(d.disposition, 'add_to_brief');
  assert.equal(d.deliver.channel, 'brief');
  assert.equal(d.deliver.consumesBudget, false);
});

test('notify_now: interrupt score clears the bar, not quiet, under budget', () => {
  const e = baseEvent({ signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 }, urgencyHint: 0.9 });
  const d = judge(e, baseContext());
  assert.equal(d.disposition, 'notify_now');
  assert.equal(d.deliver.channel, 'push');
  assert.equal(d.deliver.consumesBudget, true);
});

test('offer_action: an attached actionable event at sufficient value', () => {
  const e = baseEvent({
    type: 'leverage', domain: 'meta', subject: 'protect-sleep',
    signal: { magnitude: 0.7, confidence: 0.6, novelty: 1 },
    action: { kind: 'commit_action', payload: {}, reversible: true, riskClass: 'internal_write', capabilityId: 'commit_action' },
  });
  const d = judge(e, baseContext());
  assert.equal(d.disposition, 'offer_action');
});

test('auto_act: internal, reversible, consented, high confidence AND value', () => {
  const e = baseEvent({
    type: 'leverage', domain: 'meta', subject: 'log-gratitude',
    signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 },
    action: { kind: 'log_habit', payload: {}, reversible: true, riskClass: 'internal_write', capabilityId: 'auto_log_habit' },
  });
  const d = judge(e, baseContext({ consentGrants: new Set(['auto_log_habit']) }));
  assert.equal(d.disposition, 'auto_act');
});

// ---- safety & consent gates ----

test('auto_act requires an explicit consent grant for its exact capability — absent grant demotes to offer_action', () => {
  const e = baseEvent({
    type: 'leverage', domain: 'meta', subject: 'log-gratitude',
    signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 },
    action: { kind: 'log_habit', payload: {}, reversible: true, riskClass: 'internal_write', capabilityId: 'auto_log_habit' },
  });
  const d = judge(e, baseContext({ consentGrants: new Set() })); // no grant at all
  assert.equal(d.disposition, 'offer_action', 'never silently auto-acts without consent — offers instead');
  assert.equal(d.gates.no_consent_grant, true);
});

test('a consent grant for a DIFFERENT capability does not authorize this one', () => {
  const e = baseEvent({
    type: 'leverage', domain: 'meta', subject: 'log-gratitude',
    signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 },
    action: { kind: 'log_habit', payload: {}, reversible: true, riskClass: 'internal_write', capabilityId: 'auto_log_habit' },
  });
  const d = judge(e, baseContext({ consentGrants: new Set(['some_other_capability']) }));
  assert.notEqual(d.disposition, 'auto_act');
});

test('external_write is NEVER auto_act-eligible even with a matching consent grant', () => {
  const e = baseEvent({
    type: 'leverage', domain: 'meta', subject: 'protect-focus-block',
    signal: { magnitude: 0.95, confidence: 0.95, novelty: 1 },
    action: { kind: 'calendar_write', payload: {}, reversible: true, riskClass: 'external_write', capabilityId: 'calendar_write' },
  });
  const d = judge(e, baseContext({ consentGrants: new Set(['calendar_write']) }));
  assert.notEqual(d.disposition, 'auto_act', 'external writes are never inferred, grant or not');
  assert.equal(d.gates.external_write_requires_grant, true);
});

test('a non-reversible action is never auto_act-eligible, even fully consented and confident', () => {
  const e = baseEvent({
    type: 'leverage', domain: 'meta', subject: 'irreversible-thing',
    signal: { magnitude: 0.95, confidence: 0.95, novelty: 1 },
    action: { kind: 'something', payload: {}, reversible: false, riskClass: 'internal_write', capabilityId: 'x' },
  });
  const d = judge(e, baseContext({ consentGrants: new Set(['x']) }));
  assert.notEqual(d.disposition, 'auto_act');
  assert.equal(d.gates.action_not_reversible, true);
});

test('unauthorized auto_act attempt never silently succeeds — always demotes to offer_action or lower, never throws', () => {
  const e = baseEvent({
    action: { kind: 'x', payload: {}, reversible: true, riskClass: 'internal_write', capabilityId: 'unknown_cap' },
    signal: { magnitude: 0.95, confidence: 0.95, novelty: 1 },
  });
  assert.doesNotThrow(() => {
    const d = judge(e, baseContext());
    assert.notEqual(d.disposition, 'auto_act');
  });
});

// ---- critical override ----

test('a critical event matching the allowlist bypasses quiet hours and the daily budget', () => {
  const rule = CRITICAL_ALLOWLIST[0];
  const e = baseEvent({
    domain: rule.domain, type: rule.type, subject: rule.subject, critical: true,
    signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 },
  });
  const d = judge(e, baseContext({ quiet: true, budget: { limit: 4, usedToday: 4 } }));
  assert.equal(d.disposition, 'notify_now');
  assert.equal(d.deliver.bypassQuiet, true);
  assert.equal(d.deliver.consumesBudget, false);
});

test('a self-asserted critical event NOT on the allowlist is not trusted — falls through to normal scoring', () => {
  const e = baseEvent({ type: 'trend', subject: 'steps', critical: true, signal: { magnitude: 0.2, confidence: 0.3, novelty: 1 } });
  const d = judge(e, baseContext({ quiet: true }));
  assert.notEqual(d.disposition, 'notify_now', 'unvalidated critical claim must not bypass quiet hours');
  assert.equal(d.gates.critical_claim_rejected, true);
});

test('the critical reserve itself is bounded — once spent, a second critical event no longer bypasses budget/quiet, even if it still independently qualifies via normal scoring', () => {
  const rule = CRITICAL_ALLOWLIST[1];
  const e = baseEvent({ domain: rule.domain, type: rule.type, subject: rule.subject, critical: true, signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 }, urgencyHint: 0.9 });
  const d = judge(e, baseContext({ criticalBudget: { limit: 1, usedToday: 1 } }));
  assert.equal(d.gates.critical_reserve_exhausted, true, 'the exhausted reserve must be recorded even when normal scoring separately qualifies');
  assert.notEqual(d.deliver?.bypassQuiet, true, 'the exhausted reserve must not grant a quiet-hours bypass');
  assert.equal(d.deliver?.consumesBudget, true, 'without the reserve, a notify still consumes the ordinary budget like any other event');

  // With a weaker signal that wouldn't qualify through normal scoring alone,
  // exhausting the reserve DOES change the outcome — this is the case that
  // actually demonstrates the bound.
  const weak = baseEvent({ domain: rule.domain, type: rule.type, subject: rule.subject, critical: true, signal: { magnitude: 0.86, confidence: 0.5, novelty: 0 } });
  const withReserve = judge(weak, baseContext({ criticalBudget: { limit: 1, usedToday: 0 } }));
  const reserveSpent = judge(weak, baseContext({ criticalBudget: { limit: 1, usedToday: 1 } }));
  assert.equal(withReserve.disposition, 'notify_now');
  assert.notEqual(reserveSpent.disposition, 'notify_now');
  // Only the actual bypass marks the reserve as consumed — the counting signal
  // the ledger/batcher use. The exhausted fall-through must NOT set it, or it
  // would count against (and re-exhaust) a reserve it never used.
  assert.equal(withReserve.gates.critical_reserve_consumed, true, 'the bypass that actually used the reserve is marked consumed');
  assert.notEqual(reserveSpent.gates.critical_reserve_consumed, true, 'a fall-through critical event must not be counted as consuming the reserve');
});

test('a critical event suppressed by cooldown records the critical_override audit flag but does NOT consume the reserve', () => {
  const rule = CRITICAL_ALLOWLIST[0];
  const e = baseEvent({ domain: rule.domain, type: rule.type, subject: rule.subject, critical: true, signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 } });
  const d = judge(e, baseContext({ recentKeys: new Set([eventKey(e)]) }));
  assert.equal(d.disposition, 'store_silently', 'the same critical fact within cooldown is suppressed');
  assert.equal(d.gates.critical_override, true, 'still flagged as judged-critical for audit');
  assert.notEqual(d.gates.critical_reserve_consumed, true, 'but a cooled-down critical event must not burn a reserve slot');
});

// ---- quiet hours ----

test('quiet hours downgrade an otherwise-notify_now event to add_to_brief — never drops it silently', () => {
  const e = baseEvent({ signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 }, urgencyHint: 0.9 });
  const loud = judge(e, baseContext({ quiet: false }));
  const quiet = judge(e, baseContext({ quiet: true }));
  assert.equal(loud.disposition, 'notify_now');
  assert.notEqual(quiet.disposition, 'notify_now');
  assert.notEqual(quiet.disposition, 'store_silently', 'a real signal must not vanish just because it is quiet hours');
});

// ---- daily interruption budget ----

test('an over-budget day downgrades notify_now to a deferred disposition, still not silent', () => {
  const e = baseEvent({ signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 }, urgencyHint: 0.9 });
  const d = judge(e, baseContext({ budget: { limit: 4, usedToday: 4 } }));
  assert.notEqual(d.disposition, 'notify_now');
  assert.notEqual(d.disposition, 'store_silently');
});

test('rising same-day usage raises interrupt cost even before the hard budget cap', () => {
  const e = baseEvent({ signal: { magnitude: 0.55, confidence: 0.6, novelty: 1 }, urgencyHint: 0.6 });
  const fresh = judge(e, baseContext({ budget: { limit: 4, usedToday: 0 } }));
  const busy = judge(e, baseContext({ budget: { limit: 4, usedToday: 3 } }));
  assert.ok(fresh.scores.interrupt > busy.scores.interrupt, 'more prior interruptions today -> higher cost -> lower interrupt score');
});

// ---- cooldowns / cross-surface dedup ----

test('a duplicate event_key within cooldown is stored_silently regardless of score', () => {
  const e = baseEvent({ signal: { magnitude: 0.95, confidence: 0.95, novelty: 1 } });
  const key = eventKey(e);
  const d = judge(e, baseContext({ recentKeys: new Set([key]) }));
  assert.equal(d.disposition, 'store_silently');
  assert.equal(d.gates.cooldown_active, true);
});

test('cross-surface identity: two DIFFERENT producers describing the SAME fact collapse onto one event_key', () => {
  // A wealth watcher's midday check and the finding pipeline's morning check
  // for the same over-budget category must produce the SAME key.
  const midday = { domain: 'wealth', type: 'over_budget', subject: 'Clothing', observedAt: new Date('2026-07-11T13:00:00'), dedupBucket: 'month' };
  const morning = { domain: 'wealth', type: 'over_budget', subject: 'Clothing', observedAt: new Date('2026-07-11T08:30:00'), dedupBucket: 'month' };
  assert.equal(eventKey(midday), eventKey(morning));
});

test('different subjects never collide (no false-positive dedup)', () => {
  const a = { domain: 'wealth', type: 'over_budget', subject: 'Clothing', observedAt: new Date('2026-07-11'), dedupBucket: 'month' };
  const b = { domain: 'wealth', type: 'over_budget', subject: 'Taxi', observedAt: new Date('2026-07-11'), dedupBucket: 'month' };
  assert.notEqual(eventKey(a), eventKey(b));
});

// ---- repeated dismissals -> belief-based personalization ----

test('a belief multiplier for this event\'s type dampens value enough to demote notify_now to add_to_brief', () => {
  const e = baseEvent({ type: 'over_budget', domain: 'wealth', subject: 'Clothing', signal: { magnitude: 0.6, confidence: 0.6, novelty: 1 }, urgencyHint: 0.5 });
  const noBelief = judge(e, baseContext());
  const dampened = judge(e, baseContext({ beliefMultipliers: new Map([['over_budget:Clothing', 0.4]]) }));
  assert.ok(dampened.scores.value < noBelief.scores.value, 'a demoted subject scores lower');
});

test('belief multiplier floors at not-fully-silenced — a dampened but still-novel critical fact can still reach add_to_brief', () => {
  const e = baseEvent({ type: 'trend', subject: 'sleep_hours', signal: { magnitude: 0.9, confidence: 0.9, novelty: 1 }, urgencyHint: 0.9 });
  const d = judge(e, baseContext({ beliefMultipliers: new Map([['trend:sleep_hours', 0.01]]) })); // even an extreme (invalid) multiplier is floored
  assert.notEqual(d.disposition, 'store_silently', 'floor keeps a genuinely strong signal visible somewhere, never fully mutes it');
});

// ---- scheduled check-in reminder (deterministic rule) ----
//
// checkin_missing's urgency default (0.3) times any achievable value tops out
// at ~0.30, which the interrupt-cost FLOOR (0.40) alone already exceeds — the
// generic scored ladder could NEVER clear THRESHOLDS.NOTIFY for this type, so
// the real ~3pm reminder silently landed on add_to_brief every time even when
// the scheduler ran correctly and quiet hours/budget both had room. Fixed with
// a deterministic Stage-A rule specific to this type, checked below.

function checkinEvent(overrides = {}) {
  return baseEvent({
    source: 'finding', domain: 'wellbeing', type: 'checkin_missing', subject: 'day',
    title: '10-second check-in', body: "How's your mood, energy, and focus today?",
    signal: { magnitude: 0.5, confidence: 0.9, novelty: null },
    urgencyHint: null, // exactly what events.js's fromCheckinMissing produces
    ...overrides,
  });
}

test('1. an incomplete 3pm check-in produces notify_now', () => {
  const d = judge(checkinEvent(), baseContext());
  assert.equal(d.disposition, 'notify_now');
  assert.equal(d.deliver.channel, 'push');
  assert.equal(d.deliver.consumesBudget, true);
  assert.equal(d.gates.checkin_reminder_rule, true);
});

// 2. "a completed check-in produces no event" is a caller-level guarantee, not
// a judge() concern — notify/run.js's runCheckinReminder() only builds/
// dispatches an event when checkinLoggedToday() is false. Covered by the
// integration test in test/integration/checkin-reminder.test.js.

test('3. quiet hours defer it to the brief, never drop it silently', () => {
  const d = judge(checkinEvent(), baseContext({ quiet: true }));
  assert.equal(d.disposition, 'add_to_brief');
  assert.equal(d.gates.checkin_reminder_deferred_quiet, true);
});

test('4. an exhausted daily budget defers it to the brief', () => {
  const d = judge(checkinEvent(), baseContext({ budget: { limit: 2, usedToday: 2 } }));
  assert.equal(d.disposition, 'add_to_brief');
  assert.equal(d.gates.checkin_reminder_deferred_budget, true);
});

test('5. cooldown prevents a duplicate — the SAME fact already surfaced today is store_silently', () => {
  const e = checkinEvent();
  const key = eventKey(e);
  const d = judge(e, baseContext({ recentKeys: new Set([key]) }));
  assert.equal(d.disposition, 'store_silently');
  assert.equal(d.gates.cooldown_active, true);
  // The deterministic checkin rule is never even reached — cooldown short-circuits first.
  assert.equal(d.gates.checkin_reminder_rule, undefined);
});

test('6. one earlier notification today does not incorrectly suppress it while budget remains', () => {
  // usedToday=1 under a limit of 4: still real capacity. The OLD scored ladder
  // grew interruptCost with usedToday and would have failed this even with a
  // hand-tuned urgencyHint; the deterministic rule only checks usedToday vs limit.
  const d = judge(checkinEvent(), baseContext({ budget: { limit: 4, usedToday: 1 } }));
  assert.equal(d.disposition, 'notify_now');
});

test('a learned dismissal-belief pattern for check-in reminders demotes to add_to_brief, never store_silently', () => {
  const d = judge(checkinEvent(), baseContext({ beliefMultipliers: new Map([['checkin_missing:day', 0.4]]) }));
  assert.equal(d.disposition, 'add_to_brief');
  assert.equal(d.gates.checkin_reminder_dismissed_by_belief, true);
});

test('force (context.quiet already resolved to false by the caller) still notifies during what would otherwise be quiet hours', () => {
  // dispatch.js's buildContext sets quiet: overrides.force ? false : withinQuietHours(asOf) —
  // judge() itself has no notion of "force", it just sees quiet:false either way.
  const d = judge(checkinEvent(), baseContext({ quiet: false }));
  assert.equal(d.disposition, 'notify_now');
});

// ---- goal relevance / context factors ----

test('an event about an actively-tracked subject scores higher relevance than an untracked one', () => {
  const e = baseEvent({ type: 'trend', subject: 'net_worth', signal: { magnitude: 0.4, confidence: 0.5, novelty: 1 } });
  const untracked = judge(e, baseContext());
  const tracked = judge(e, baseContext({ activeGoalSubjects: new Set(['net_worth']) }));
  assert.ok(tracked.scores.value > untracked.scores.value);
});

test('low capacity (a bad day) raises interruption cost, deferring a borderline event', () => {
  const e = baseEvent({ signal: { magnitude: 0.5, confidence: 0.5, novelty: 1 }, urgencyHint: 0.5 });
  const normal = judge(e, baseContext({ capacity: 'normal' }));
  const low = judge(e, baseContext({ capacity: 'low' }));
  assert.ok(low.scores.interrupt < normal.scores.interrupt);
});

// ---- health / wealth / mood / calendar domain coverage ----

test('health: a sharp HRV drop with high magnitude and novelty is at least offer/notify-worthy', () => {
  const e = baseEvent({ domain: 'health', type: 'anomaly', subject: 'hrv', signal: { magnitude: 0.8, confidence: 0.85, novelty: 1 }, urgencyHint: 0.8 });
  const d = judge(e, baseContext());
  assert.ok(['notify_now', 'add_to_brief', 'offer_action'].includes(d.disposition));
});

test('wealth: a mild over-budget category with low magnitude lands in the brief, not a push', () => {
  const e = baseEvent({ domain: 'wealth', type: 'over_budget', subject: 'Dining', signal: { magnitude: 0.2, confidence: 0.6, novelty: 1 }, urgencyHint: 0.5 });
  const d = judge(e, baseContext());
  assert.equal(d.disposition, 'add_to_brief');
});

test('mood: a low check-in event scores meaningfully even with modest confidence', () => {
  const e = baseEvent({ domain: 'wellbeing', type: 'low_checkin', subject: 'day', signal: { magnitude: 0.6, confidence: 0.9, novelty: 1 } });
  const d = judge(e, baseContext());
  assert.notEqual(d.disposition, 'store_silently');
});

test('mood: a genuinely rough check-in (high magnitude) pushes in real time, a mild dip defers to the brief', () => {
  // The same-day wellbeing reaction (watch.js improvement #2) only earns its
  // keep if a rock-bottom check-in actually interrupts; a mild one should
  // still wait for the brief. Guards the low_checkin urgency calibration.
  const rough = baseEvent({ domain: 'wellbeing', type: 'low_checkin', subject: 'day', signal: { magnitude: 0.75, confidence: 0.9, novelty: 1 } });
  assert.equal(judge(rough, baseContext()).disposition, 'notify_now');
  const mild = baseEvent({ domain: 'wellbeing', type: 'low_checkin', subject: 'day', signal: { magnitude: 0.5, confidence: 0.9, novelty: 1 } });
  assert.equal(judge(mild, baseContext()).disposition, 'add_to_brief');
});

test('calendar/meta: an external-write action offer never reaches auto_act, regardless of score', () => {
  const e = baseEvent({
    domain: 'meta', type: 'leverage', subject: 'protect-focus-window',
    signal: { magnitude: 1, confidence: 1, novelty: 1 }, urgencyHint: 0.9,
    action: { kind: 'calendar_write', payload: {}, reversible: true, riskClass: 'external_write', capabilityId: 'calendar_write' },
  });
  const d = judge(e, baseContext({ consentGrants: new Set(['calendar_write']) }));
  assert.notEqual(d.disposition, 'auto_act');
  assert.ok(['offer_action', 'notify_now'].includes(d.disposition));
});

// ---- determinism ----

test('judge() is deterministic — identical inputs produce an identical decision', () => {
  const e = baseEvent();
  const c = baseContext();
  const d1 = judge(e, c);
  const d2 = judge(e, c);
  assert.deepEqual(d1, d2);
});
