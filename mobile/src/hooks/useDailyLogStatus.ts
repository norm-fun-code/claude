import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { CHECKIN_TODAY_URL, HABITS_TODAY_URL, authHeaders, fetchWithTimeout, localDateStr } from '../config';

// Tracks whether today's check-in and habits have been logged, so the Today
// tab can badge the check-in button when either is still outstanding. Refreshes
// on mount, on demand (call refresh() after the check-in modal closes), and when
// the app returns to the foreground on a new calendar day.
const todayLocal = () => localDateStr();

export function useDailyLogStatus() {
  const [checkinLogged, setCheckinLogged] = useState(true);
  const [habitsLogged, setHabitsLogged] = useState(true);
  const fetchDateRef = useRef('');

  const refresh = useCallback(async () => {
    fetchDateRef.current = todayLocal();
    try {
      const [ci, hb] = await Promise.all([
        fetchWithTimeout(CHECKIN_TODAY_URL, { headers: authHeaders() }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetchWithTimeout(HABITS_TODAY_URL, { headers: authHeaders() }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      // Default to "logged" on a failed fetch so we never nag on a network blip.
      if (ci) setCheckinLogged(!!ci.logged);
      if (hb) setHabitsLogged(!!hb.logged);
    } catch {
      /* leave prior state — best effort */
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // New-day reset: re-check when returning to foreground after midnight.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && fetchDateRef.current !== todayLocal()) refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  return { needsLog: !checkinLogged || !habitsLogged, refresh };
}
