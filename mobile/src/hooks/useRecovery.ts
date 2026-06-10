import { useCallback, useEffect, useState } from 'react';
import { API_BASE, authHeaders, fetchWithTimeout } from '../config';
import type { Recovery } from './useBriefing';

const RECOVERY_URL = `${API_BASE}/api/recovery`;

/**
 * Live recovery score from the dedicated fast endpoint — a sub-second fetch,
 * unlike the full briefing build the score used to ride along with. The Health
 * tab uses this so pull-to-refresh updates the recovery card immediately
 * without forcing (or waiting on) a briefing rebuild.
 */
export function useRecovery() {
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout(RECOVERY_URL, { headers: authHeaders() });
      if (res.ok) {
        const d = await res.json();
        if (d?.recovery) setRecovery(d.recovery);
      }
    } catch {
      // keep the last value (or the briefing fallback) on failure
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { recovery, loading, refetch };
}
