// Health tab redesign (audit rec #4) — pure derivation of the Training
// summary card's copy/primary-action from the SAME canonical facts the
// Training drill-in (WorkoutsPanel) already persists to/reads from:
// backend's getEffectiveWorkout (BriefingData.effectiveWorkout) and the
// workout_completions record for today (GET /api/workout/completions). No
// new authority — this only formats what those two already say.
import type { EffectiveWorkoutFact } from './healthState';

export type TrainingPrimaryAction = 'start' | 'continue' | 'review_completed' | 'log_different';

export interface WorkoutCompletionFact {
  workoutId?: string | null;
  source?: 'manual' | 'activity_match' | null;
}

export interface TrainingSummary {
  label: string;
  duration: string | null;
  /** True when today's effective session differs from the static weekly plan
   *  (a manual swap, or an automatic recovery-based downgrade). */
  isAdjusted: boolean;
  /** One deterministic sentence explaining the adjustment — empty when
   *  `isAdjusted` is false. Never model-generated. */
  adjustmentReason: string;
  isDone: boolean;
  primaryAction: TrainingPrimaryAction;
  primaryActionLabel: string;
}

function adjustmentReasonFor(fact: EffectiveWorkoutFact): string {
  if (fact.source === 'override') {
    return fact.scheduledLabel ? `Swapped from ${fact.scheduledLabel}.` : 'Manually swapped.';
  }
  if (fact.source === 'auto_downgrade') {
    const band = fact.recoveryBand ? `${fact.recoveryBand} recovery` : 'today’s recovery';
    return fact.scheduledLabel ? `${band} downgraded ${fact.scheduledLabel} to ${fact.label}.` : `Downgraded for ${band}.`;
  }
  return '';
}

/** Pure, total — never throws regardless of how incomplete the inputs are
 *  (an older cached briefing with no effectiveWorkout field, e.g.). */
export function describeTrainingSummary(
  effectiveWorkout: EffectiveWorkoutFact | null | undefined,
  completion: WorkoutCompletionFact | null | undefined
): TrainingSummary {
  const fact = effectiveWorkout ?? {};
  const label = fact.label ?? 'Rest';
  const isAdjusted = fact.source === 'override' || fact.source === 'auto_downgrade';
  const isDone = Boolean(completion?.workoutId && completion.workoutId === fact.workoutId);

  let primaryAction: TrainingPrimaryAction;
  let primaryActionLabel: string;
  if (isDone) {
    primaryAction = 'review_completed';
    primaryActionLabel = 'Review completed workout';
  } else if (fact.workoutId === 'rest') {
    primaryAction = 'log_different';
    primaryActionLabel = 'Log what I actually did';
  } else {
    // "Continue" vs "Start" is a client-only nuance (has anything been logged
    // yet today?) — deliberately left to the caller, which already tracks
    // logged sets/checks locally; this pure function only needs the binary
    // not-done case to decide the default label.
    primaryAction = 'start';
    primaryActionLabel = 'Start workout';
  }

  return {
    label,
    duration: fact.duration ?? null,
    isAdjusted,
    adjustmentReason: isAdjusted ? adjustmentReasonFor(fact) : '',
    isDone,
    primaryAction,
    primaryActionLabel,
  };
}
