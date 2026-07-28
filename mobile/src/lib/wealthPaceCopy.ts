// Pure formatting for the discretionary MTD matched-pace comparison
// (backend/src/services/wealth-pace.js's `comparison` object) — every value
// here is read straight off that server-computed object, never derived, so
// this stays outside wealthNoDuplication.test.ts's forbidden-arithmetic
// guard. Lives in src/lib (not the .tsx component) so it can be unit tested
// directly — this project's test runner (`node --experimental-strip-types`)
// only strips TS types, it cannot transform JSX.
import type { WealthLanding } from '../hooks/useBriefing';

export type PaceComparison = NonNullable<NonNullable<WealthLanding['numbers']['mtdDiscretionary']>['comparison']>;

// Exact calm-language phrases the product requires — never "needs attention"
// for a spending-pace reading, and never a manufactured percentage against a
// too-small baseline (server already sets pct to null in that case).
export const PACE_COPY: Record<string, string> = {
  below_typical: 'below typical pace',
  near_typical: 'near typical pace',
  above_typical: 'above typical pace',
  well_above_typical: 'well above typical pace',
};

function money(n: number | null | undefined): string {
  if (n == null) return '—';
  return (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
}

export function paceLine(cmp: PaceComparison): string {
  const label = PACE_COPY[cmp.paceLabel] ?? 'near typical pace';
  const pctPart = cmp.vsMedian.pct != null ? `${Math.abs(cmp.vsMedian.pct)}% ` : '';
  let line = `${pctPart}${label}`;
  if (cmp.vsPreviousMonth) {
    const dir = cmp.vsPreviousMonth.dollars >= 0 ? 'above' : 'below';
    const pctPart2 = cmp.vsPreviousMonth.pct != null ? `${Math.abs(cmp.vsPreviousMonth.pct)}% ` : '';
    line += ` · ${pctPart2}${dir} last month`;
  }
  return line;
}

export function driverLine(drivers: PaceComparison['drivers']): string | null {
  if (!drivers.length) return null;
  return 'Driven by ' + drivers.map((d) => `${d.category} +${money(d.excessDollars)}`).join(' and ');
}
