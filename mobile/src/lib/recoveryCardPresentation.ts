// Pure presentation-derivation for RecoveryCard.tsx's band color/label/gradient —
// extracted so the "provisional recovery must never render on the same
// red/amber/green scale as a confirmed reading" contract is unit-testable.
// Mirrors HealthStateCard.tsx's treatment of the same `recovery.proxy` flag.

export interface RecoveryPresentationInput {
  proxy?: boolean | null;
  category?: string | null;
  band?: 'green' | 'yellow' | 'red' | string | null;
  presentation?: { tier?: string | null; label?: string | null } | null;
}

export interface RecoveryCardColors {
  subtext: string;
  green: string;
  warmGreen: string;
  amber: string;
  red: string;
  yellow: string;
}

export interface RecoveryPresentationResult {
  tier: string | null;
  bandColor: string;
  bandLabel: string;
  gradientKey: string;
  displayBandLabel: string;
}

export function deriveRecoveryPresentation(recovery: RecoveryPresentationInput, colors: RecoveryCardColors): RecoveryPresentationResult {
  const tier = recovery.proxy ? null : recovery.presentation?.tier ?? null;
  const bandColor = recovery.proxy ? colors.subtext
    : tier === 'ready' ? colors.green
      : tier === 'solid_near_green' ? colors.warmGreen
      : tier === 'moderate' ? colors.amber
      : tier === 'low' ? colors.red
      : recovery.band === 'green' ? colors.green
      : recovery.band === 'yellow' ? colors.yellow
      : recovery.band === 'red' ? colors.red
      : colors.subtext;
  const bandLabel = recovery.presentation?.label ??
    (recovery.band === 'green' ? 'Recovered'
      : recovery.band === 'yellow' ? 'Moderate'
      : recovery.band === 'red' ? 'Low'
      : 'Recovery');
  const gradientKey = recovery.proxy ? 'neutral'
    : tier === 'solid_near_green' ? 'warmGreen' : tier === 'moderate' ? 'amber' : (recovery.band ?? 'neutral');
  const displayBandLabel = recovery.proxy ? `${recovery.category ?? bandLabel} · provisional` : bandLabel;

  return { tier, bandColor, bandLabel, gradientKey, displayBandLabel };
}
