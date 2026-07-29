import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { DEFAULT_CANONICAL_TZ, canonicalLocalDate, msUntilNextLocalMidnight } from '../lib/canonicalDay';

export interface CanonicalDay {
  /** Today's local calendar date (YYYY-MM-DD) in the canonical timezone. */
  localDate: string;
  tz: string;
}

/** Cross-day lifecycle fix — the ONE shared source of "what day/time is it
 *  right now" every day-boundary comparison in the app must use: Header's
 *  date/greeting, cross-day cache validation, Wisdom freshness, rebuild
 *  local-day validation. Anchored to the canonical (home-base) timezone —
 *  pass the latest known `timezone` from a briefing payload once one has
 *  loaded; defaults to America/New_York before that. Updates on foreground,
 *  at the next local-day boundary, and whenever `tz` itself changes. Never
 *  derives "today" from a cached content payload's own date field — that is
 *  exactly the bug this hook exists to prevent from recurring. */
export function useCanonicalDay(tz: string = DEFAULT_CANONICAL_TZ): CanonicalDay {
  const [localDate, setLocalDate] = useState(() => canonicalLocalDate(new Date(), tz));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const recompute = () => setLocalDate(canonicalLocalDate(new Date(), tz));
    recompute();

    const scheduleNext = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        recompute();
        scheduleNext();
      }, msUntilNextLocalMidnight(new Date(), tz));
    };
    scheduleNext();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') { recompute(); scheduleNext(); }
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      sub.remove();
    };
  }, [tz]);

  return { localDate, tz };
}
