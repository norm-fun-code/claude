// Pure helpers extracted from WealthPostureCard.tsx so they're unit
// testable (this project's test runner only strips TS types, it cannot
// transform JSX — see wealthPaceCopy.ts for the same pattern).
import { colors as themeColors } from '../theme.ts';

// Overall-position tone (backend/src/services/wealth-landing.js's
// derivePositionConclusion) — deliberately a SEPARATE color decision from
// per-category severity: the headline reflects the household's overall
// monthly trajectory (spending pace + savings + plan), never per-category
// exceptions, so it must never read cautionary just because 1-2 categories
// stand out elsewhere on the card. Inferred from the headline text itself
// since the backend intentionally returns prose, not a second severity
// enum, to keep this conclusion a single readable sentence rather than
// another taxonomy.
//
// Wealth matched-pace audit: the real headline wording changed from
// "Spending is <adjective> pace" to "Discretionary spending is <adjective>
// typical" (only the neutral in_line case still says "...typical pace" /
// "...typical pace, though other signals are mixed") — match on "typical",
// not "pace", for the comparison-based cases so this doesn't silently fall
// through to the neutral color for the common case.
export function positionTone(headline: string): string {
  if (/well above typical/i.test(headline)) return themeColors.red;
  if (/above typical|off pace|mixed/i.test(headline)) return themeColors.amber;
  if (/below typical|healthy/i.test(headline)) return themeColors.green;
  return themeColors.subtext;
}

// Compact display formatting ONLY (never a derivation — same number, fewer
// digits) for the compact-metrics row, matching the target copy's "+$77.8K"
// style rather than a full "$77,800".
export function compactMoney(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  return `${sign}$${Math.round(abs)}`;
}
