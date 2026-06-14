// Shared display formatters.

/**
 * Format a duration given in HOURS as "Xh Ym" — e.g. 6.875 → "6h 53m".
 * Norm prefers hours-and-minutes over decimal hours ("6.9h" reads worse than
 * "6h 53m"). Rounds to the nearest minute. Returns "—" for null/NaN.
 *  - whole hours drop the minutes ("8h"), sub-hour drops the hours ("48m").
 */
export function formatHM(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return '—';
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
