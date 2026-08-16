// Explicit period identity for the weekly review — the same truth-and-evidence
// contract the goals block already satisfies via WeeklyIntentionsCard's
// weekOfLabel ("every render names WHICH week it is, so it can never be
// silently conflated with a different week's").
//
// The review itself had no such label. Its narrative says things like "the
// week's alcohol nights (Tue, Wed) and back-to-back travel (Thu, Fri)" —
// accurate for the week it covers, but read on a Monday (when the review of
// the week just ended is what's on screen) "the week" naturally reads as the
// week that just started, in which none of it has happened yet. Reported
// exactly that way: "alcohol nights and travel were last week not this past
// week", for a review of Aug 3-9 citing Aug 4/5 and Aug 6/7.
//
// Naming the range removes the ambiguity without touching the generated text.

/**
 * "Week of Aug 3–9" for a review whose period starts on `weekStart`
 * (YYYY-MM-DD, the period_start the server stamps). Returns null for a
 * missing/unparseable value so the caller simply renders nothing.
 *
 * The end is weekStart + 6 days: the stored period is a 7-day window, and
 * naming an inclusive last day is what a reader checks their memory against.
 * Formatted in the given timeZone so it can't drift a day near midnight.
 */
export function reviewPeriodLabel(weekStart: string | null | undefined, timeZone: string): string | null {
  if (!weekStart) return null;
  // Anchor at midday UTC: a bare YYYY-MM-DD parses as UTC midnight, which in a
  // western timezone renders as the PREVIOUS day.
  const start = new Date(`${String(weekStart).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);

  const month = (d: Date) => d.toLocaleDateString('en-US', { timeZone, month: 'short' });
  const day = (d: Date) => d.toLocaleDateString('en-US', { timeZone, day: 'numeric' });

  // "Aug 3–9" when both fall in one month, "Jul 27–Aug 2" when they straddle.
  const sameMonth = month(start) === month(end);
  return sameMonth
    ? `Week of ${month(start)} ${day(start)}–${day(end)}`
    : `Week of ${month(start)} ${day(start)}–${month(end)} ${day(end)}`;
}
