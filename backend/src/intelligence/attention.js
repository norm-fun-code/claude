// The Judgment and Attention Policy — the single place that answers "given
// this event, what (if anything) should NormOS do about it right now?"
//
// PURE. No DB, no clock reads beyond what's passed in, no push, no LLM. Every
// input the policy needs is handed to it explicitly (see PolicyContext below),
// so `judge()` is a plain function: same (event, context) in, same Decision
// out, every time — fully unit-testable without a database or a mock clock.
//
// Design: deterministic GATES run first, in order, and short-circuit (Stage
// A). Only an event that survives every gate reaches the scored ladder
// (Stage B). Defaults are conservative on purpose — an event the gates don't
// recognize and the score doesn't clearly justify interrupting for lands on
// store_silently or add_to_brief, never on notify_now/auto_act by default.
//
// The seven primary dispositions (exactly one per judged event):
//   store_silently | update_belief | ask_question | add_to_brief |
//   notify_now | offer_action | auto_act

// ---- Tunable constants (named, not magic numbers scattered through the code) ----

const THRESHOLDS = {
  NOTIFY: 0.25,   // interrupt score above this -> notify_now (if budget/quiet allow)
  OFFER: 0.55,    // value above this (with an action attached) -> offer_action
  ASK: 0.45,      // value above this (with a real uncertainty) -> ask_question
  BRIEF: 0.30,    // value above this -> at least add_to_brief
  AUTO_CONFIDENCE: 0.80,
  AUTO_VALUE: 0.60,
};

// Cost of delay per event type, when the producer doesn't supply its own
// urgencyHint. Deliberately hand-picked per type (not derived) — these are
// product judgment calls, exactly like the existing per-domain constants
// throughout intelligence/ (DOMAIN_WEIGHT, IMPORTANCE, etc.).
const URGENCY_DEFAULTS = {
  anomaly: 0.8,
  // A rough same-day check-in is the one signal whose whole point is to reach
  // the user IN THE MOMENT (watch.js's same-day wellbeing reaction) — a dip
  // noticed only in tomorrow's brief is a dip missed. At 0.85 a genuinely low
  // check-in (a rating of 1, or multiple low dimensions) clears the interrupt
  // bar and pushes, while a single mild dip (rating 2) still defers to the
  // brief. Lower and NO low check-in could ever push, defeating the feature.
  low_checkin: 0.85,
  commitment_due: 0.7,
  over_budget: 0.5,
  budget_pace: 0.4,
  new_recurring: 0.35,
  forecast_risk: 0.55,
  leverage: 0.3,
  cross_context: 0.35,
  trend: 0.3,
  checkin_missing: 0.3,
  statement: 0.1,
  dismissal_pattern: 0.1,
  outcome: 0.1,
};

// How long one exact fact (one event_key) stays suppressed after being
// surfaced to the user, before the SAME fact is allowed to interrupt again.
// Distinct from the daily BUDGET (which caps how many DIFFERENT facts land
// in one day) — this caps repeating the SAME fact.
const COOLDOWN_HOURS_BY_TYPE = {
  anomaly: 20,
  low_checkin: 20,
  over_budget: 24 * 30,
  budget_pace: 24,
  new_recurring: 24 * 60, // matches the legacy nudges-table 60-day dedup window this replaces
  leverage: 24 * 3,
  cross_context: 24 * 14,
  forecast_risk: 24,
  trend: 24 * 3,
  commitment_due: 3, // the commitment system's own re-nudge cadence governs this in practice
  checkin_missing: 20,
};
const DEFAULT_COOLDOWN_HOURS = 20;

function cooldownHoursFor(type) {
  return COOLDOWN_HOURS_BY_TYPE[type] ?? DEFAULT_COOLDOWN_HOURS;
}

// A producer's `critical: true` is a CLAIM, not a fact — it only actually
// bypasses quiet hours / the daily budget if it also matches one of these
// explicit, narrow conditions. A self-asserted-critical event that doesn't
// match anything here is logged and falls through to normal scoring, exactly
// like a non-critical event — self-assertion alone never grants an override.
const CRITICAL_ALLOWLIST = [
  { domain: 'health', type: 'anomaly', subject: 'respiratory_rate', minMagnitude: 0.85 },
  { domain: 'health', type: 'anomaly', subject: 'resting_hr', minMagnitude: 0.85 },
];

function matchesCriticalAllowlist(event) {
  return CRITICAL_ALLOWLIST.some(
    (rule) =>
      rule.domain === event.domain &&
      rule.type === event.type &&
      rule.subject === event.subject &&
      (event.signal?.magnitude ?? 0) >= rule.minMagnitude
  );
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/** Belief-derived multiplier for this event's (type, subject) — from the
 *  beliefs layer's dismissal patterns / stated preferences. 1.0 = no belief
 *  on file. Floors at 0.4 so a belief can suppress but never fully silence a
 *  genuinely novel/urgent recurrence forever (a demoted event still reaches
 *  add_to_brief, never drops to nothing). */
function beliefMultiplierFor(event, context) {
  const key = `${event.type}:${event.subject}`;
  const byType = context.beliefMultipliers?.get(`type:${event.type}`);
  const bySubject = context.beliefMultipliers?.get(key);
  const m = bySubject ?? byType ?? 1.0;
  return Math.max(0.4, Math.min(1.5, m));
}

/** Pure: does `subject` fall under something the user is already actively
 *  tracking (a stated goal, a life chapter, an open commitment)? Relevance
 *  is a binary-ish signal on purpose — "is this about something they already
 *  said matters" is a much cleaner question than trying to grade degrees of
 *  relevance without more context than events carry. */
function isRelevant(event, context) {
  const s = event.subject;
  if (!s) return false;
  return (
    context.activeGoalSubjects?.has(s) ||
    context.activeChapterSubjects?.has(s) ||
    context.openCommitmentSubjects?.has(s) ||
    false
  );
}

/**
 * Pure: build the canonical cross-surface event-identity key. Two producers
 * describing the SAME underlying fact (e.g. a wealth watcher's midday
 * over_budget check and the morning finding pipeline's over_budget finding
 * for the same category) collapse onto this SAME key, so the dedup gate
 * (Stage A) catches the second one regardless of which surface produced it —
 * that's the "never duplicate one event across surfaces" guarantee.
 */
function eventKey(event) {
  const bucket = bucketFor(event.observedAt, event.dedupBucket || 'day');
  return `${event.domain}:${event.type}:${event.subject}:${bucket}`;
}

function bucketFor(observedAt, granularity) {
  const d = observedAt instanceof Date ? observedAt : new Date(observedAt || Date.now());
  if (granularity === 'month') return d.toISOString().slice(0, 7);
  if (granularity === 'week') {
    // ISO week bucket — coarse is fine here, this only needs to group "the
    // same rough period," not calendar-precise ISO week numbers.
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${week}`;
  }
  return d.toISOString().slice(0, 10); // day
}

/**
 * The pure judgment function. `event` is a normalized AttentionEvent (see
 * intelligence/events.js); `context` is a PolicyContext assembled once by the
 * caller (notify/dispatch.js) from the ledger/beliefs/quiet-hours/etc. Never
 * reads a clock or a database itself.
 */
function judge(event, context) {
  const gates = {};

  // ---- Malformed input: fail conservatively, never notify on garbage ----
  // Checked BEFORE computing eventKey(), which itself assumes a well-formed
  // event (reads event.observedAt) — a null/partial event must never reach it.
  if (!event || !event.domain || !event.type || !event.subject) {
    return decision('store_silently', 'malformed event (missing domain/type/subject)', { gates: { malformed: true } });
  }

  const key = eventKey(event);

  // ---- Stage A: deterministic gates, in order, short-circuit ----

  // 1) Belief routing — belief events never interrupt; they update the model.
  if (event.belief) {
    gates.belief_routing = true;
    const alsoBrief = (event.signal?.confidence ?? 0) >= 0.8 && isRelevant(event, context);
    return decision('update_belief', 'event carries a belief payload — updates the model, does not interrupt', {
      gates, secondary: alsoBrief ? ['add_to_brief'] : [],
    });
  }

  // 2) Authorization gate — external writes are NEVER auto-eligible by
  // inference. This only narrows what Stage B may choose; it doesn't itself
  // return, since offer_action may still be appropriate.
  let actionEligible = { offer: !!event.action, auto: !!event.action };
  if (event.action?.riskClass === 'external_write') {
    gates.external_write_requires_grant = true;
    actionEligible.auto = false; // offer stays possible; auto_act is not, ever, without a grant
  }
  if (event.action && event.action.riskClass !== 'external_write') {
    const granted = context.consentGrants?.has(event.action.capabilityId);
    if (!granted) {
      gates.no_consent_grant = true;
      actionEligible.auto = false;
    }
  }
  if (event.action && !event.action.reversible) {
    gates.action_not_reversible = true;
    actionEligible.auto = false;
  }

  // 3) Critical override — validated against the allowlist, not self-asserted,
  // AND still bounded by its own small reserve (default 1/day) so a flood of
  // events that happen to hit the allowlist can't become unlimited interrupts.
  const isCritical = event.critical === true && matchesCriticalAllowlist(event);
  if (event.critical === true && !isCritical) gates.critical_claim_rejected = true;
  if (isCritical) {
    // `critical_override` marks "this event was judged critical" (audit); it is
    // NOT the reserve-accounting signal. The reserve is only actually SPENT on
    // the bypass return below, flagged `critical_reserve_consumed` — that (not
    // critical_override) is what the ledger counts and the batcher increments,
    // so a critical event that falls through (on cooldown, or reserve already
    // spent) never burns a slot it didn't use.
    gates.critical_override = true;
    const criticalOverBudget = (context.criticalBudget?.usedToday ?? 0) >= (context.criticalBudget?.limit ?? 1);
    if (!(context.recentKeys?.has(key)) && !criticalOverBudget) {
      gates.critical_reserve_consumed = true;
      return decision('notify_now', 'critical event matched the explicit allowlist — bypasses quiet hours and the daily budget', {
        gates, deliver: { channel: 'push', consumesBudget: false, bypassQuiet: true, usesCriticalReserve: true },
      });
    }
    if (criticalOverBudget) gates.critical_reserve_exhausted = true;
    // Falls through to normal scoring even when critical: the SAME critical
    // fact within cooldown, or the reserve being spent, still leaves normal
    // scoring (Stage B) as the fallback — a critical event that can't use its
    // reserve is still worth judging on its own considerable magnitude.
  }

  // 4) Duplicate / cooldown gate — the SAME fact, already surfaced recently.
  if (context.recentKeys?.has(key)) {
    gates.cooldown_active = true;
    return decision('store_silently', `already surfaced within the ${cooldownHoursFor(event.type)}h cooldown for this fact`, { gates });
  }

  // ---- Stage B: scoring ----
  const magnitude = clamp01(event.signal?.magnitude ?? 0.5);
  const confidence = clamp01(event.signal?.confidence ?? 0.5);
  const novelty = event.signal?.novelty ?? (context.noveltyByKey?.has(key) ? 0 : 1);
  const relevance = isRelevant(event, context) ? 1.0 : 0.5;
  const beliefMultiplier = beliefMultiplierFor(event, context);

  let value = clamp01(0.35 * magnitude + 0.25 * confidence + 0.20 * novelty + 0.20 * relevance) * beliefMultiplier;
  value = clamp01(value);

  const urgency = clamp01(event.urgencyHint ?? URGENCY_DEFAULTS[event.type] ?? 0.3);

  const usedToday = context.budget?.usedToday ?? 0;
  const capacityPenalty = context.capacity === 'low' ? 0.20 : 0;
  const interruptCost = 0.40 + capacityPenalty + 0.15 * usedToday;
  const interrupt = value * urgency - interruptCost;

  const scores = { value: round(value), urgency: round(urgency), interrupt: round(interrupt), novelty: round(novelty), relevance };

  const overBudget = (context.budget?.usedToday ?? 0) >= (context.budget?.limit ?? Infinity);
  const quiet = !!context.quiet;

  // notify_now: clears the interrupt bar AND isn't blocked by quiet hours or
  // the daily budget. Quiet/over-budget don't drop the event — they DEFER it
  // (falls through to the lower rungs of the ladder below), never discard it.
  if (interrupt >= THRESHOLDS.NOTIFY && !quiet && !overBudget) {
    gates.cleared_interrupt_bar = true;
    return decision('notify_now', `interrupt score ${round(interrupt)} cleared the ${THRESHOLDS.NOTIFY} bar`, {
      gates, scores, deliver: { channel: 'push', consumesBudget: true, bypassQuiet: false },
    });
  }
  if (interrupt >= THRESHOLDS.NOTIFY && (quiet || overBudget)) {
    gates.deferred_quiet_or_budget = true; // recorded for audit; falls through
  }

  // auto_act: internal, reversible, explicitly consented, high confidence AND
  // value. Checked before offer_action so a fully-qualified auto-actionable
  // event doesn't get demoted to a mere offer.
  if (
    event.action &&
    actionEligible.auto &&
    event.action.riskClass === 'internal_write' &&
    event.action.reversible &&
    confidence >= THRESHOLDS.AUTO_CONFIDENCE &&
    value >= THRESHOLDS.AUTO_VALUE
  ) {
    gates.auto_act_qualified = true;
    return decision('auto_act', `internal, reversible, consented action with confidence ${round(confidence)} and value ${round(value)}`, {
      gates, scores, deliver: { channel: quiet ? 'brief' : 'push', consumesBudget: !quiet, bypassQuiet: false },
    });
  }

  if (event.action && actionEligible.offer && value >= THRESHOLDS.OFFER) {
    gates.offer_action_qualified = true;
    return decision('offer_action', `actionable event with value ${round(value)} at or above the ${THRESHOLDS.OFFER} offer bar`, {
      gates, scores, deliver: { channel: quiet || overBudget ? 'brief' : 'push', consumesBudget: !(quiet || overBudget), bypassQuiet: false },
    });
  }

  if (event.hasUncertainty && value >= THRESHOLDS.ASK && (context.questionBudgetLeft ?? 1) > 0) {
    gates.ask_question_qualified = true;
    return decision('ask_question', `genuine uncertainty with value ${round(value)} — worth a single question`, {
      gates, scores, deliver: { channel: 'question', consumesBudget: false, bypassQuiet: false },
    });
  }

  if (value >= THRESHOLDS.BRIEF) {
    gates.brief_default = true;
    return decision('add_to_brief', `value ${round(value)} is real but below the interrupt/offer bar — deferred to the next briefing`, {
      gates, scores, deliver: { channel: 'brief', consumesBudget: false, bypassQuiet: false },
    });
  }

  gates.below_all_thresholds = true;
  return decision('store_silently', `value ${round(value)} did not clear the ${THRESHOLDS.BRIEF} brief-inclusion bar`, { gates, scores });
}

function round(n, d = 3) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function decision(disposition, reason, { gates = {}, scores = {}, secondary = [], deliver = null } = {}) {
  return { disposition, reason, gates, scores, secondary, deliver };
}

module.exports = {
  judge,
  eventKey,
  cooldownHoursFor,
  matchesCriticalAllowlist,
  THRESHOLDS,
  URGENCY_DEFAULTS,
  COOLDOWN_HOURS_BY_TYPE,
  CRITICAL_ALLOWLIST,
};
