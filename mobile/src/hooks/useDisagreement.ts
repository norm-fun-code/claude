import { useCallback, useEffect, useState } from 'react';
import { DISAGREEMENT_URL, DISAGREEMENT_RESOLVE_URL, authHeaders, fetchWithTimeout } from '../config';
import type { Disagreement } from '../lib/disagreementCopy';

/**
 * The disagreement surface — at most one, usually none.
 *
 * `null` is the normal and hoped-for answer: it means no goal is being set
 * repeatedly and missed repeatedly. As with usePrecedent, "not fetched yet"
 * and "nothing to say" are deliberately not distinguished, because a card
 * explaining that it has no criticism for you today would be its own kind of
 * nagging.
 */
export function useDisagreement() {
  const [disagreement, setDisagreement] = useState<Disagreement | null>(null);
  const [resolving, setResolving] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(DISAGREEMENT_URL, { headers: authHeaders() }, 20000);
      if (res.ok) {
        const d = await res.json();
        setDisagreement((d?.disagreement as Disagreement | null) ?? null);
      }
    } catch {
      // Keep whatever is on screen — a months-long pattern does not go wrong
      // by being a few minutes stale.
    }
  }, []);

  /**
   * Answer it. All three choices resolve it, because all three are legitimate
   * answers to "is the goal wrong, or the plan?" — the surface takes no side.
   * Cleared locally on success so it disappears the moment it is answered,
   * rather than lingering until the next fetch.
   */
  const resolve = useCallback(async (choice: 'revise' | 'keep' | 'retire') => {
    if (!disagreement) return;
    setResolving(true);
    try {
      await fetchWithTimeout(
        DISAGREEMENT_RESOLVE_URL,
        {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            resolutionKey: disagreement.resolutionKey,
            choice,
            // The count they were actually shown, so re-activation is measured
            // from what they saw rather than a later recomputation.
            statements: disagreement.counts.statements,
          }),
        },
        12000
      );
      setDisagreement(null);
    } catch {
      // Leave it up — silently swallowing the failure would look like the
      // answer was recorded when it was not.
    } finally {
      setResolving(false);
    }
  }, [disagreement]);

  useEffect(() => { refetch(); }, [refetch]);

  return { disagreement, resolve, resolving, refetch };
}
