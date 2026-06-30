import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { EVENING_BRIEF_URL, authHeaders, fetchWithTimeout } from '../config';

export type EveningTone = 'settled' | 'mild' | 'elevated' | 'unknown';

export interface EveningBrief {
  tone: EveningTone;
  headline: string;
  readiness: string;
  today: string;
  tomorrow: string;
  habits: string;
  signals: {
    hrv: number | null;
    hrvBaseline: number | null;
    rhr: number | null;
    rhrBaseline: number | null;
    steps: number | null;
    stepsBaseline: number | null;
    activeEnergy: number | null;
    openHabits: string[];
  };
  day: string;
  builtAt?: string;
  generatedAt?: string;
}

// The wind-down brief is built + pushed by the 9:30pm scheduler job. The card
// only ever SHOWS what that job created — it never builds on demand — so it can't
// appear early (e.g. opening the app at 3pm). Until tonight's build exists, the
// fetch returns null and the card stays hidden.
export function useEveningBrief() {
  const [brief, setBrief] = useState<EveningBrief | null>(null);
  const [loading, setLoading] = useState(false);
  // True once the first fetch has resolved — so the cold-open welcome can wait for
  // the evening brief (which inserts at the top of the feed) to settle before it
  // dissolves, instead of revealing a feed that then jumps.
  const [fetched, setFetched] = useState(false);

  const fetchBrief = useCallback(async (): Promise<EveningBrief | null> => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout(EVENING_BRIEF_URL, { headers: authHeaders() }, 12000);
      if (res.ok) {
        const data = await res.json();
        const next = data && data.headline ? (data as EveningBrief) : null;
        setBrief(next);
        return next;
      }
    } catch {
      /* offline — leave prior state */
    } finally {
      setLoading(false);
      setFetched(true);
    }
    return null;
  }, []);

  // Fetch today's brief on mount (null until the 9:30pm job has built it).
  useEffect(() => { fetchBrief(); }, [fetchBrief]);

  // Re-check on foreground — picks up the brief once the evening push has fired.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') fetchBrief();
    });
    return () => sub.remove();
  }, [fetchBrief]);

  return { brief, loading, fetched, refetch: fetchBrief };
}
