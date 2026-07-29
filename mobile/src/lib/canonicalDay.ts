// Cross-day lifecycle fix: one canonical notion of "what day is it right
// now", anchored to the app's home-base timezone (backend routes/briefing.js
// process.env.TZ, always America/New_York unless a payload reports a
// different `timezone`) — NEVER the phone's physical timezone and NEVER a
// cached content payload's own `date`/`localDate` field. Pure/testable
// helpers here; the React hook (useCanonicalDay.ts) wraps these with
// AppState + timer plumbing.
export const DEFAULT_CANONICAL_TZ = 'America/New_York';

/** Pure: today's local calendar date (YYYY-MM-DD) in `tz`, as of `now`. */
export function canonicalLocalDate(now: Date, tz: string = DEFAULT_CANONICAL_TZ): string {
  return now.toLocaleDateString('en-CA', { timeZone: tz });
}

function partsInTz(now: Date, tz: string): { hour: number; minute: number; second: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  let hour = get('hour');
  if (hour === 24) hour = 0; // some ICU implementations render midnight as "24"
  return { hour, minute: get('minute'), second: get('second') };
}

/** Pure: the wall-clock hour (0-23) in `tz`, as of `now` — the SAME
 *  canonical-timezone instant `canonicalLocalDate` derives the date string
 *  from. Header/greeting hardening: a greeting computed from the device's
 *  own physical timezone while the date next to it is computed from the
 *  canonical (home-base) timezone can disagree (e.g. "Good evening" next to
 *  a date that's already tomorrow in the canonical zone, or vice versa, for
 *  a phone that has traveled) — both must be derived from this one function
 *  in the same zone. */
export function canonicalHour(now: Date, tz: string = DEFAULT_CANONICAL_TZ): number {
  return partsInTz(now, tz).hour;
}

/** Pure: milliseconds from `now` until the next local-midnight boundary in
 *  `tz` — computed from the wall-clock time-of-day in that zone (never raw
 *  UTC-offset arithmetic, which breaks across DST transitions), plus a small
 *  safety buffer. The caller must re-verify via canonicalLocalDate when the
 *  timer fires rather than trust this number alone — background timers on
 *  mobile OSes are unreliable, and this is a scheduling hint, not a proof. */
export function msUntilNextLocalMidnight(now: Date, tz: string = DEFAULT_CANONICAL_TZ): number {
  const { hour, minute, second } = partsInTz(now, tz);
  const elapsedMs = ((hour * 60 + minute) * 60 + second) * 1000 + now.getMilliseconds();
  const remaining = 24 * 60 * 60 * 1000 - elapsedMs;
  return Math.max(1000, remaining) + 1500;
}
