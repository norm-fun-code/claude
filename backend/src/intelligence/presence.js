// PRESENCE — NormOS speaks when something changes, not when the clock says.
//
// The Attention Policy (intelligence/attention.js) already answers "given this
// event, is it worth interrupting for?" — with gates, cooldowns, a daily
// budget, and quiet hours. It is excellent, and it is asked exactly ONCE a day,
// from runNonEssentialMorningWork right after the morning brief.
//
// That is the whole reason the app feels scheduled rather than awake. Whatever
// happens between 8am and tomorrow's 8am — Eight Sleep syncing a bad night,
// Monarch posting an unusual charge, a commitment falling due, a workout
// swapped, an annotation retracted — is not evaluated until the next morning.
// The judgment is live; only the asking is on a cron.
//
// This module supplies the missing half: WHEN to ask. It does not judge, does
// not send, and does not decide what is worth saying — those all remain the
// Attention Policy's job, unchanged. It decides only whether enough has
// actually changed, and enough time has passed, to be worth re-asking.
//
// THE FAILURE MODE IS OBVIOUS AND FATAL. A system that re-evaluates on every
// mutation would evaluate a few hundred times during a single Apple Health
// sync, and an assistant that speaks whenever it can is one you turn off. So
// the pacing here is deliberately conservative and, like everything else in
// this codebase, the gates are reasons to do NOTHING:
//
//   * Nothing changed → never evaluate. This is the entire point: presence is
//     driven by real state movement, never by elapsed time. A quiet afternoon
//     costs zero passes.
//   * A burst is one change. Two hundred metric rows from one sync is a single
//     event; the debounce waits for the writes to settle before asking.
//   * A floor between passes, whatever happens. Even a genuinely eventful hour
//     cannot produce more than a handful of evaluations.
//   * A ceiling on deferral, so a continuously-noisy source (a sync that
//     dribbles rows for an hour) can't starve evaluation forever by keeping
//     the debounce permanently un-settled.
//
// Note what is NOT here: quiet hours, per-fact cooldowns, and the daily
// interrupt budget. Those belong to the Attention Policy and already work.
// Re-implementing them here would create a second, drifting copy of rules that
// have exactly one right answer — and would also break its ability to DEFER a
// quiet-hours event into the morning brief rather than drop it.
'use strict';

const { TRIGGER } = require('../brain/registry');

/**
 * Which state changes are worth re-asking about.
 *
 * An allowlist rather than "everything", because several triggers describe
 * bookkeeping the user has no stake in hearing about. Each entry below is here
 * because a real, user-visible signal can follow from it within minutes.
 */
const REACTIVE_TRIGGERS = new Set([
  // An overnight sync landed, or recovery moved materially — the single most
  // time-sensitive signal in the app, and today it waits for tomorrow.
  TRIGGER.RECOVERY_CHANGE,
  // Spending posted. An unusual charge is worth knowing about today, not
  // tomorrow morning after it has already cleared.
  TRIGGER.TRANSACTION_SYNC,
  // Something the user explicitly agreed to do changed state.
  TRIGGER.COMMITMENT_CHANGE,
  // The day's plan moved, which can make earlier advice wrong.
  TRIGGER.WORKOUT_OVERRIDE,
  TRIGGER.TRAINING_CHANGE,
  // New life context can EXPLAIN an anomaly already surfaced — re-asking can
  // retire a question rather than raise one, which is just as valuable.
  TRIGGER.ANNOTATION_RETIREMENT,
  TRIGGER.CONTEXT_ASSERTION_CHANGE,
]);

// A goal edit and a nightly context-tag submission are deliberately absent:
// both are the user typing INTO the app, already looking at it. Reacting to
// them would mean NormOS interrupting someone mid-sentence about the thing
// they are in the middle of telling it.

/** Wait for a burst of writes to settle before treating it as one change. */
const DEBOUNCE_MS = 90 * 1000;
/** Hard floor between evaluations, however eventful things get. */
const MIN_INTERVAL_MS = 10 * 60 * 1000;
/** Ceiling on how long a pending change may be held by an un-settling debounce
 *  before it is evaluated anyway. */
const MAX_DEFER_MS = 30 * 60 * 1000;

/**
 * Pure: should a presence pass run right now?
 *
 * @param {object} state
 * @param {number|null} state.lastEvaluatedAt epoch ms of the last pass, or null.
 * @param {number|null} state.lastBumpAt epoch ms of the most recent reactive
 *   state change since that pass, or null when nothing has changed.
 * @param {number|null} state.firstBumpAt epoch ms of the FIRST change since the
 *   last pass — what the deferral ceiling is measured from, so a source that
 *   keeps bumping cannot postpone evaluation indefinitely.
 * @param {number} now epoch ms.
 * @returns {{evaluate: boolean, reason: string}} `reason` is for the
 *   diagnostic endpoint and the log line; it is never shown to the user.
 */
function shouldEvaluate({ lastEvaluatedAt = null, lastBumpAt = null, firstBumpAt = null } = {}, now = Date.now()) {
  // The core rule. No change, no pass — presence is event-driven, and a quiet
  // afternoon must cost nothing at all.
  if (!lastBumpAt) return { evaluate: false, reason: 'nothing_changed' };

  if (lastEvaluatedAt != null && now - lastEvaluatedAt < MIN_INTERVAL_MS) {
    return { evaluate: false, reason: 'min_interval' };
  }

  // Held long enough that waiting for silence is no longer reasonable — a sync
  // dribbling rows for half an hour would otherwise never settle.
  const pendingFor = firstBumpAt != null ? now - firstBumpAt : now - lastBumpAt;
  if (pendingFor >= MAX_DEFER_MS) return { evaluate: true, reason: 'max_defer' };

  if (now - lastBumpAt < DEBOUNCE_MS) return { evaluate: false, reason: 'debouncing' };

  return { evaluate: true, reason: 'settled' };
}

/**
 * Pure: fold one incoming trigger into the pending-change state.
 *
 * Returns a NEW state object rather than mutating, so the scheduler's live
 * state is replaced atomically and this stays trivially testable. A trigger
 * outside the allowlist leaves the state untouched — it does not merely fail
 * to schedule a pass, it does not count as a pending change at all.
 */
function recordTrigger(state, trigger, now = Date.now()) {
  if (!REACTIVE_TRIGGERS.has(trigger)) return state;
  return {
    ...state,
    lastBumpAt: now,
    firstBumpAt: state?.firstBumpAt ?? now,
    triggers: [...new Set([...(state?.triggers || []), trigger])],
  };
}

/** Pure: the state after a pass has run — pending changes are consumed, so the
 *  next pass requires genuinely new movement rather than re-firing on the same
 *  change forever. */
function afterEvaluation(state, now = Date.now()) {
  return { ...state, lastEvaluatedAt: now, lastBumpAt: null, firstBumpAt: null, triggers: [] };
}

module.exports = {
  shouldEvaluate,
  recordTrigger,
  afterEvaluation,
  REACTIVE_TRIGGERS,
  DEBOUNCE_MS,
  MIN_INTERVAL_MS,
  MAX_DEFER_MS,
};
