// Shared display-formatting helpers — consolidates the identical local
// `money()` implementations that were independently copy-pasted into
// WealthPostureCard.tsx, WealthExploreScreen.tsx, and wealthPaceCopy.ts.
// Pure formatting only — never derives a value, only renders one already
// computed elsewhere.
export function formatMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
}
