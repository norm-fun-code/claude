// Pure formatting for the discretionary MTD matched-pace comparison
// (backend/src/services/wealth-pace.js's `comparison` object) — every value
// here is read straight off that server-computed object, never derived, so
// this stays outside wealthNoDuplication.test.ts's forbidden-arithmetic
// guard. Lives in src/lib (not the .tsx component) so it can be unit tested
// directly — this project's test runner (`node --experimental-strip-types`)
// only strips TS types, it cannot transform JSX.
import type { WealthLanding } from '../hooks/useBriefing';
import { formatMoney as money } from './format.ts';

export type PaceComparison = NonNullable<NonNullable<WealthLanding['numbers']['mtdDiscretionary']>['comparison']>;

// Exact calm-language phrases the product requires — never "needs attention"
// for a spending-pace reading, and never a manufactured percentage against a
// too-small baseline (server already sets pct to null in that case).
// Wealth matched-pace audit: SYMMETRIC 5-band scheme — within +/-10% of
// typical is "in_line"; 10-20% either side is "slightly_*"; beyond 20%
// either side is "comfortably_*". Replaces the old asymmetric 4-band scheme
// (below_typical/near_typical/above_typical/well_above_typical), whose
// missing "slightly below" bucket let an 11%-below month read as
// "comfortably below" — see backend/src/services/wealth-pace.js.
export const PACE_COPY: Record<string, string> = {
  comfortably_below: 'comfortably below typical pace',
  slightly_below: 'slightly below typical pace',
  in_line: 'in line with typical pace',
  slightly_above: 'slightly above typical pace',
  comfortably_above: 'well above typical pace',
};

export function paceLine(cmp: PaceComparison): string {
  const label = PACE_COPY[cmp.paceLabel] ?? PACE_COPY.in_line;
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
