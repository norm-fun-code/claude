// The ONE canonical, deterministic "what is today, training-wise" object —
// the authoritative fact/state layer every Today surface (Chief Brief
// generation + validation, todayCommandCenter's pre-render guard, and any
// other consumer of "today's plan") must resolve from and validate against,
// instead of each surface independently re-deriving or lexically patching
// its own read of the day.
//
// Root cause this exists to fix: the headline (Chief Brief `synthesis`) and
// the action (Chief Brief `action`) are two SEPARATE free-text fields from
// the same LLM call — nothing forced them to agree with each other or with
// the authoritative plan. A prior fix added lexical checks
// (checkRestFramingAgainstEffectiveWorkout /
// checkHardWorkoutAgainstRestOverride in claimValidator.js) that correctly
// catch "rest day" verbatim, but the model's ONE bounded correction retry
// can reword a caught violation into an equally-wrong PARAPHRASE ("Treat
// today as a genuine rest day, not a data point." / "...is the only
// structured load.") that a narrow phrase list doesn't recognize — the
// retry ships unvalidated against anything broader. This module is the
// single, reusable semantic surface both the correction-retry validation
// AND the pre-render defense-in-depth guard call, so broadening coverage
// happens in exactly one place, not per-surface.
'use strict';

const TRAINING_DAY_STATE = Object.freeze({
  WORKOUT: 'WORKOUT',
  REST: 'REST',
  UNRESOLVED_CONFLICT: 'UNRESOLVED_CONFLICT',
});

/**
 * THE authoritative training-day state for today. Pure — takes the SAME
 * `effectiveWorkout` shape services/workout.js's getEffectiveWorkout()
 * already returns (override > auto_downgrade > scheduled precedence is
 * resolved there; this function never re-derives it) and packages it with
 * the identity/provenance fields every Today surface needs to agree on the
 * SAME resolved object rather than each computing their own.
 *
 * State is UNRESOLVED_CONFLICT only when there is no effective workout to
 * resolve against at all (a caller error / missing data) — getEffectiveWorkout
 * itself is single-authority and always resolves to exactly one workout
 * (override wins, then auto-downgrade, then the schedule), so there is no
 * scenario where the DETERMINISTIC facts alone disagree with each other.
 * UNRESOLVED_CONFLICT in practice is reached one layer up, by
 * validateTrainingDayContent below: when GENERATED prose can't be brought
 * into agreement with this resolved state even after the one correction
 * retry, the content layer reports the conflict rather than the fact layer
 * inventing ambiguity that isn't really there.
 *
 * @param {object} input
 * @param {{label?:string, source?:string, workoutId?:string,
 *   scheduledLabel?:string, scheduledWorkoutId?:string}|null} input.effectiveWorkout
 * @param {Array<{activityType:string, label?:string}>} [input.loggedActualActivities]
 * @param {string|null} [input.snapshotId]
 * @param {number|null} [input.snapshotVersion]
 * @param {string|null} [input.resolvedAt] ISO timestamp; defaults to now.
 */
function resolveTrainingDayState({
  effectiveWorkout = null, loggedActualActivities = [],
  snapshotId = null, snapshotVersion = null, resolvedAt = null,
} = {}) {
  const label = effectiveWorkout?.label ?? null;
  const isRest = label != null && String(label).trim().toLowerCase() === 'rest';
  const state = !label
    ? TRAINING_DAY_STATE.UNRESOLVED_CONFLICT
    : (isRest ? TRAINING_DAY_STATE.REST : TRAINING_DAY_STATE.WORKOUT);

  return {
    state,
    effectiveWorkout: effectiveWorkout ?? null,
    explicitOverride: effectiveWorkout?.source === 'override'
      ? { workoutId: effectiveWorkout.workoutId ?? null, label: effectiveWorkout.label ?? null }
      : null,
    plannedWorkout: effectiveWorkout?.scheduledLabel
      ? { label: effectiveWorkout.scheduledLabel, workoutId: effectiveWorkout.scheduledWorkoutId ?? null }
      : (effectiveWorkout?.label ? { label: effectiveWorkout.label, workoutId: effectiveWorkout.workoutId ?? null } : null),
    loggedActualActivity: Array.isArray(loggedActualActivities) ? loggedActualActivities : [],
    provenance: effectiveWorkout?.source ?? null,
    snapshotId, snapshotVersion,
    resolvedAt: resolvedAt || new Date().toISOString(),
  };
}

// Deliberately broader than a single literal phrase ("rest day") per the
// explicit requirement that semantic equivalents must be covered too —
// still an EXPLICIT, bounded phrase list (precision-first, matching this
// codebase's established claim-validator philosophy) rather than a fuzzy
// classifier, so it stays auditable and never false-positives on a
// genuinely scheduled "Recovery + Mobility" session (deliberately does NOT
// match bare "recovery day" — that phrase legitimately describes a real,
// distinct prescribed session, not the absence of one).
const REST_FRAMING_RE =
  /\brest day\b|\bfull rest\b|\b(?:taking|take) (?:a |the )?day off\b|\bresting (?:today|instead)\b|\bskip(?:ping)? (?:my |today'?s )?(?:workout|training|session)\b|\bno training\b|\bnothing (?:planned|scheduled) (?:for )?(?:training|your workout|the gym)\b|\bavoid(?:ing)? (?:load|training|exertion)\b|\bgenuine rest\b|\btreat(?:ing)? today as (?:a )?rest\b|\bstand ?down\b|\boff from training\b/i;

/** True when `text` frames today as a day with no training at all — the
 *  broadened successor to services/workout.js's isRestDayCommitment for
 *  GENERATED prose (that one stays scoped to short user-typed commitments). */
function describesRestFraming(text) {
  return REST_FRAMING_RE.test(String(text || ''));
}

// Framing verbs/phrases that PRESCRIBE a session, beyond the narrow
// action-verb list claimValidator.js's checkEffectiveWorkout already uses
// for its own (different) purpose — covers passive/descriptive framing
// ("is on deck", "is the only structured load") a model can retreat into
// after being told not to use an imperative verb.
const WORKOUT_DIRECTIVE_RE =
  /\b(scale back|ease off|crush|hit|do|tackle|power through|go hard on|push through|send|get after it|let'?s do|go get)\b|\bon deck\b|\bis up\b|\bplanned for today\b|\bscheduled for today\b|\bcalls for\b|\btime for\b|\btoday'?s (?:session|workout) is\b|\bstructured (?:load|demand)\b/i;

/** True when `text` describes today's session as something to actually do
 *  (imperative OR descriptive framing), naming the given workout label. */
function describesHardWorkoutDirective(text, label) {
  const t = String(text || '');
  if (!label || !WORKOUT_DIRECTIVE_RE.test(t)) return false;
  const firstWord = String(label).trim().split(/\s+/)[0];
  if (!firstWord) return false;
  return new RegExp(`\\b${firstWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)
    || WORKOUT_DIRECTIVE_RE.test(t); // "structured load"/"on deck" etc. often omit the label name itself
}

/**
 * The structural post-generation guard: does this chief-brief content agree
 * with the resolved trainingDayState? Scans every checkable field (not just
 * one), so a contradiction anywhere — headline, action, or elsewhere —
 * is caught, matching the production bug where the headline alone carried
 * the violation. Pure; returns `{ valid, violations }`.
 *
 * @param {{state:string, effectiveWorkout:object|null, plannedWorkout:object|null}} trainingDayState
 * @param {{synthesis?:string, action?:string, risk?:string, move?:string, morningFocus?:string}} fields
 *   flat field-name -> text map (chiefBrief fields + morningFocus already merged).
 */
function validateTrainingDayContent(trainingDayState, fields) {
  const violations = [];
  const entries = Object.entries(fields || {}).filter(([, v]) => typeof v === 'string' && v.trim());

  if (trainingDayState.state === TRAINING_DAY_STATE.WORKOUT) {
    for (const [field, text] of entries) {
      if (describesRestFraming(text)) {
        violations.push({
          check: 'training_day_state_workout_vs_rest_claim', field, text,
          message: `trainingDayState is WORKOUT (${trainingDayState.effectiveWorkout?.label}), but this field frames today as a rest/no-training day`,
        });
      }
    }
  } else if (trainingDayState.state === TRAINING_DAY_STATE.REST) {
    const scheduledLabel = trainingDayState.plannedWorkout?.label;
    for (const [field, text] of entries) {
      if (scheduledLabel && describesHardWorkoutDirective(text, scheduledLabel) && !describesRestFraming(text)) {
        violations.push({
          check: 'training_day_state_rest_vs_workout_directive', field, text,
          message: `trainingDayState is REST (explicit override), but this field still prescribes ${scheduledLabel}`,
        });
      }
    }
  }
  // UNRESOLVED_CONFLICT: nothing to validate content against — the caller
  // (todayCommandCenter.js) renders the resolution UI directly instead.

  return { valid: violations.length === 0, violations };
}

module.exports = {
  TRAINING_DAY_STATE,
  resolveTrainingDayState,
  describesRestFraming,
  describesHardWorkoutDirective,
  validateTrainingDayContent,
};
