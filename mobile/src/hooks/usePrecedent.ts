import { useCallback, useEffect, useState } from 'react';
import { PRECEDENT_URL, authHeaders, fetchWithTimeout } from '../config';
import type { Precedent } from '../lib/precedentCopy';

/**
 * "You've been here before" — precedent retrieval over the metrics spine.
 *
 * Fetched independently of the briefing, exactly like useRecovery: the
 * briefing build is the app's slow, LLM-bearing path and this is pure
 * retrieval, so it has no business queueing behind it. Today is complete
 * without this card and strictly better with it, which is what lets it simply
 * arrive when it arrives.
 *
 * `precedent` is null both before the first response AND whenever the server's
 * evidence gates were not met — those two are deliberately NOT distinguished
 * in the UI. There is no "not enough history yet" placeholder, because a card
 * explaining its own absence every morning is worse than no card: the honest
 * state of "nothing to say today" should look like nothing.
 */
export function usePrecedent() {
  const [precedent, setPrecedent] = useState<Precedent | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout(PRECEDENT_URL, { headers: authHeaders() }, 25000);
      if (res.ok) {
        const d = await res.json();
        setPrecedent((d?.precedent as Precedent | null) ?? null);
        setFetched(true);
      }
    } catch {
      // Keep whatever was last shown on a network failure — a precedent set is
      // historical and does not go wrong by being a few minutes old.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { precedent, loading, fetched, refetch };
}
