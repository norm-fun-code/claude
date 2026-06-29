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

// The wind-down brief is an evening artifact. Before ~3pm there's nothing useful to
// say, so the card stays hidden. After that it fetches today's brief; if the 9:30pm
// build hasn't run yet (you opened the app early), ?refresh=1 builds it on demand.
const EVENING_HOUR = 15;

export function useEveningBrief() {
  const [brief, setBrief] = useState<EveningBrief | null>(null);
  const [loading, setLoading] = useState(false);

  const isEvening = () => new Date().getHours() >= EVENING_HOUR;

  const fetchBrief = useCallback(async (refresh = false): Promise<EveningBrief | null> => {
    if (!isEvening()) { setBrief(null); return null; }
    setLoading(true);
    try {
      const url = refresh ? `${EVENING_BRIEF_URL}?refresh=1` : EVENING_BRIEF_URL;
      const res = await fetchWithTimeout(url, { headers: authHeaders() }, refresh ? 30000 : 12000);
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
    }
    return null;
  }, []);

  // First load: fetch today's brief; if nothing's built yet this evening (you
  // opened the app before the 9:30pm job), build it on demand.
  useEffect(() => {
    (async () => {
      if (!isEvening()) return;
      const found = await fetchBrief(false);
      if (!found) await fetchBrief(true);
    })();
  }, [fetchBrief]);

  // Re-check when returning to foreground (e.g. crossed into the evening window).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') fetchBrief(false);
    });
    return () => sub.remove();
  }, [fetchBrief]);

  return { brief, loading, refetch: () => fetchBrief(true) };
}
