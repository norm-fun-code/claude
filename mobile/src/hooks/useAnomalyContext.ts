// "What explains this?" — optional context loop for anomaly cards. Thin
// fetch/mutate hook over POST /api/anomaly-context/... (backend/src/routes/
// anomalyContext.js). Card state is fetched on-demand when a detail view
// opens (see WorthKnowingCard.tsx) rather than embedded in the cached
// briefing payload, so opening a Worth Knowing detail never triggers a
// full briefing rebuild.
import { useState, useCallback } from 'react';
import { ANOMALY_CONTEXT_URL, authHeaders, fetchWithTimeout } from '../config';

export interface AnomalyContextCard {
  anomalyKey: string;
  metric: string;
  domains: string[];
  observedValue: number | null;
  baselineMean: number | null;
  unit: string | null;
  localObservationDate: string;
  status: 'unanswered' | 'answered' | 'skipped';
  eligible: boolean;
  rawAnswer: string | null;
}

function keyPath(anomalyKey: string, action: string): string {
  return `${ANOMALY_CONTEXT_URL}/${encodeURIComponent(anomalyKey)}/${action}`;
}

export function useAnomalyContext() {
  const [card, setCard] = useState<AnomalyContextCard | null>(null);
  const [loading, setLoading] = useState(false);

  const ensure = useCallback(async (metric: string, domains: string[] | undefined, evidence: Record<string, unknown>) => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout(`${ANOMALY_CONTEXT_URL}/ensure`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ metric, domains: domains ?? [], evidence }),
      }, 10000);
      if (!res.ok) { setCard(null); return null; }
      const json = (await res.json()) as AnomalyContextCard;
      setCard(json);
      return json;
    } catch {
      setCard(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const answer = useCallback(async (anomalyKey: string, text: string) => {
    const res = await fetchWithTimeout(keyPath(anomalyKey, 'answer'), {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ text }),
    }, 15000);
    if (res.ok) setCard((prev) => (prev ? { ...prev, status: 'answered', rawAnswer: text } : prev));
    return res.ok;
  }, []);

  const nothingUnusual = useCallback(async (anomalyKey: string) => {
    const res = await fetchWithTimeout(keyPath(anomalyKey, 'nothing-unusual'), { method: 'POST', headers: authHeaders() }, 10000);
    if (res.ok) setCard((prev) => (prev ? { ...prev, status: 'answered', rawAnswer: 'Nothing unusual' } : prev));
    return res.ok;
  }, []);

  const skip = useCallback(async (anomalyKey: string) => {
    const res = await fetchWithTimeout(keyPath(anomalyKey, 'skip'), { method: 'POST', headers: authHeaders() }, 10000);
    if (res.ok) setCard((prev) => (prev ? { ...prev, status: 'skipped' } : prev));
    return res.ok;
  }, []);

  const forget = useCallback(async (anomalyKey: string) => {
    const res = await fetchWithTimeout(keyPath(anomalyKey, 'forget'), { method: 'POST', headers: authHeaders() }, 10000);
    if (res.ok) setCard((prev) => (prev ? { ...prev, status: 'unanswered', rawAnswer: null, eligible: true } : prev));
    return res.ok;
  }, []);

  return { card, loading, ensure, answer, nothingUnusual, skip, forget };
}
