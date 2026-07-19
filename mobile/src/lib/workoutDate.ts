// Pure, dependency-free date/weekday helpers backing WorkoutsPanel's
// day-selection state (bug fix: a workout swapped/checked off on Wednesday
// was still showing Wednesday's checks and set logs when the app was
// reopened days later on Sunday). Extracted so the actual date-rollover
// logic is unit-testable under this project's test runner
// (`node --experimental-strip-types --test`, which cannot import .tsx) —
// see playbackOwnership.ts for the established pattern. WorkoutsPanel.tsx
// wraps these with real Date/AppState calls; createRequestGuard (also from
// playbackOwnership.ts) guards against a stale day's fetch response landing
// after the selection has moved on to a different date.

/** A date string as YYYY-MM-DD in `tz`, `offsetDays` from `now` — always the
 *  device/user's actual local calendar date, never a UTC-boundary one. */
export function localDateInTz(now: Date, tz: string, offsetDays = 0): string {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

/**
 * Weekday of a YYYY-MM-DD date string, Mon=0..Sun=6 — pure calendar math on
 * the string's own components. The date string already names a specific
 * local calendar date, so this needs no "now"/timezone input; it must NOT be
 * derived by comparing to today's weekday (that was the bug: a weekday index
 * computed relative to "today" at some point in the past silently pointed at
 * a different date once today moved on, while the index itself stayed the
 * same number).
 */
export function weekdayIndexOfDate(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // Sun=0..Sat=6
  return (jsDay + 6) % 7; // Mon=0..Sun=6
}

/**
 * True when the local calendar date has moved on since it was last observed
 * — the trigger for snapping the selected workout day back to "today" on
 * foreground-resume. False (no reset) when the date hasn't changed, so a day
 * deliberately selected earlier in the same session survives an unrelated
 * background/foreground cycle on the same calendar date.
 */
export function shouldResetToToday(lastKnownToday: string, newToday: string): boolean {
  return newToday !== lastKnownToday;
}
