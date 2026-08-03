import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { API_BASE, authHeaders, fetchWithTimeout } from '../config';
import type { Recovery } from './useBriefing';

const RECOVERY_URL = `${API_BASE}/api/recovery`;

export type RecoveryBand = 'green' | 'yellow' | 'red';

// Throttle for the foreground-refresh listener below — same rationale as
// useBriefing's own foreground throttle: the 'active' event fires on every
// trivial transition (Control Center, Face ID, share sheets…), not just a
// genuine "picked the phone back up" moment.
const FOREGROUND_THROTTLE_MS = 60000;

/**
 * Live recovery score from the dedicated fast endpoint — a sub-second fetch,
 * unlike the full briefing build the score used to ride along with. The Health
 * tab uses this so pull-to-refresh updates the recovery card immediately
 * without forcing (or waiting on) a briefing rebuild.
 */
export function useRecovery() {
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [needsSleepCheckIn, setNeedsSleepCheckIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const lastOkRef = useRef(0);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout(RECOVERY_URL, { headers: authHeaders() });
      if (res.ok) {
        const d = await res.json();
        // Always update — including null, so stale recovery clears when Eight Sleep is away.
        setRecovery(d?.recovery ?? null);
        setNeedsSleepCheckIn(Boolean(d?.needsSleepCheckIn));
        setFetched(true);
        lastOkRef.current = Date.now();
      }
    } catch {
      // keep the last value on network failure (don't clear valid data on flaky connections)
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // needsSleepCheckIn is a "does TODAY need a check-in" fact — with no
  // refresh beyond the initial mount, an app that's stayed open (backgrounded
  // and foregrounded, never force-quit) across a day boundary keeps whatever
  // value it fetched on the last cold launch. That silently hid the
  // SleepCheckInCard on exactly the mornings it exists for: no Eight Sleep
  // reading AND no self-report yet today, but the client never re-asked.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (Date.now() - lastOkRef.current < FOREGROUND_THROTTLE_MS) return;
      refetch();
    });
    return () => sub.remove();
  }, [refetch]);

  return { recovery, needsSleepCheckIn, loading, fetched, refetch };
}
