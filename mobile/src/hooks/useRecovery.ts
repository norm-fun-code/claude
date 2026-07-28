import { useCallback, useEffect, useState } from 'react';
import { API_BASE, authHeaders, fetchWithTimeout } from '../config';
import type { Recovery } from './useBriefing';

const RECOVERY_URL = `${API_BASE}/api/recovery`;

export type RecoveryBand = 'green' | 'yellow' | 'red';

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

  return { recovery, needsSleepCheckIn, loading, fetched, refetch };
}
