// Health tab redesign (audit rec #4) — the ONE place that turns the two
// canonical facts (liveRecovery's `recovery`, backend/src/services/workout.js's
// `getEffectiveWorkout` — shipped on BriefingData as `effectiveWorkout`) into
// the "today's state" hero's label/decision/explanation. Pure, no I/O, no new
// authority: every input here already comes from an existing canonical source
// (App.tsx's `liveRecovery` hook and `d.effectiveWorkout`), never recomputed.
import type { Recovery, RecoveryPresentation } from '../hooks/useBriefing';

export type HealthStateLabel = 'Ready' | 'Solid — near green' | 'Proceed with care' | 'Recover' | 'Provisional';
export type TrainingDecision = 'Train as planned' | 'Reduce intensity' | 'Recovery only' | 'Rest';

export interface EffectiveWorkoutFact {
  source?: 'override' | 'auto_downgrade' | 'scheduled' | null;
  workoutId?: string | null;
  label?: string | null;
  duration?: string | null;
  scheduledWorkoutId?: string | null;
  scheduledLabel?: string | null;
  recoveryBand?: string | null;
}

export interface HealthStateResult {
  stateLabel: HealthStateLabel;
  decision: TrainingDecision;
  /** True when the state is a self-reported proxy, no current overnight
   *  device reading — must never be presented with the same confidence as a
   *  device-backed reading (truth-and-evidence contract). */
  isProvisional: boolean;
  /** One concise sentence explaining WHY — deterministic, no model text. */
  explanation: string;
  /** Human label for where the recovery number (if any) came from. */
  sourceLabel: 'Eight Sleep' | 'Self-reported' | 'Unavailable';
}

type Tier = RecoveryPresentation['tier'] | null;

/** Canonical-band fallback for a Recovery reading with no `presentation`
 *  field (an older cached briefing, or a build predating this field) — maps
 *  band alone onto a tier, conservatively treating the whole yellow range as
 *  'moderate' (matches this function's pre-presentation behavior) rather
 *  than assuming a near-green read it can't actually confirm. */
function fallbackTier(band: Recovery['band']): Tier {
  if (band === 'green') return 'ready';
  if (band === 'yellow') return 'moderate';
  if (band === 'red') return 'low';
  return null;
}

/** Pure: does this decision reduce to "just rest" vs "train, but easier"?
 *  A bare solid_near_green tier (a near-green score, e.g. 59) never reduces
 *  intensity on its own — only 'moderate' and 'low' do. */
function decisionFor(tier: Tier, workoutId: string | null | undefined): TrainingDecision {
  if (tier === 'low') return workoutId === 'rest' ? 'Rest' : 'Recovery only';
  if (tier === 'moderate') return 'Reduce intensity';
  return 'Train as planned';
}

/**
 * Resolve today's compact state: label + decision + one-line explanation.
 * `recovery` null/undefined means no reading at all (not even a self-report)
 * — surfaced as Provisional with a conservative decision, never a confident
 * claim about a body state we have no evidence for.
 */
export function resolveHealthState(
  recovery: Recovery | null | undefined,
  effectiveWorkout: EffectiveWorkoutFact | null | undefined
): HealthStateResult {
  const workoutId = effectiveWorkout?.workoutId ?? null;
  const workoutLabel = effectiveWorkout?.label ?? 'today’s workout';

  if (!recovery || recovery.score == null) {
    return {
      stateLabel: 'Provisional',
      decision: decisionFor(null, workoutId),
      isProvisional: true,
      explanation: 'No recovery reading yet today — showing the scheduled plan without a recovery-based adjustment.',
      sourceLabel: 'Unavailable',
    };
  }

  const band = recovery.band;
  const tier: Tier = recovery.presentation?.tier ?? fallbackTier(band);
  const isProxy = Boolean(recovery.proxy);

  // A self-reported reading is a subjective proxy, not a device measurement —
  // the state itself must read as provisional regardless of how good the
  // self-report was, never "Ready"/"Recovered" with device-level confidence.
  if (isProxy) {
    const decision = decisionFor(tier, workoutId);
    return {
      stateLabel: 'Provisional',
      decision,
      isProvisional: true,
      explanation: `Based on your self-reported sleep (${recovery.category ?? 'unrated'}) — no Eight Sleep reading last night, so this is a subjective estimate, not a device measurement.`,
      sourceLabel: 'Self-reported',
    };
  }

  const decision = decisionFor(tier, workoutId);
  let stateLabel: HealthStateLabel;
  let explanation: string;
  if (tier === 'ready') {
    stateLabel = 'Ready';
    explanation = `Recovery is green (${recovery.score}) — ${workoutLabel} as planned.`;
  } else if (tier === 'solid_near_green') {
    // A near-green score (e.g. 59) — canonically still 'yellow', but never
    // presented as under-recovered or told to reduce intensity on its own.
    stateLabel = 'Solid — near green';
    explanation = recovery.presentation?.guidance
      ?? `Solid readiness (${recovery.score}) — train as planned if you feel good; no automatic need to scale back.`;
  } else if (tier === 'moderate') {
    stateLabel = 'Proceed with care';
    explanation = `Recovery is moderate (${recovery.score}) — dial back intensity today.`;
  } else if (tier === 'low') {
    stateLabel = 'Recover';
    explanation = effectiveWorkout?.source === 'auto_downgrade'
      ? `Recovery is low (${recovery.score}) — ${effectiveWorkout.scheduledLabel ?? 'today’s session'} was swapped for ${workoutLabel}.`
      : `Recovery is low (${recovery.score}) — favor rest or light movement today.`;
  } else {
    stateLabel = 'Provisional';
    explanation = 'Recovery band is unknown from the current reading.';
  }

  return { stateLabel, decision, isProvisional: false, explanation, sourceLabel: 'Eight Sleep' };
}
