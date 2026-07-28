// Memory (product audit rec #6 — separate conversation History from durable
// Memory). Thin fetch/mutate hook over GET /api/memory (backend/src/routes/
// memory.js) — a categorized projection over the SAME canonical
// context_assertions/beliefs stores every other surface reads, never a
// second truth model. Belief-origin mutations reuse the EXISTING
// /api/beliefs/:id/... endpoints directly (see BeliefsCard.tsx for the same
// convention) rather than duplicating them behind /memory.
import { useState, useCallback, useEffect } from 'react';
import { MEMORY_URL, BELIEFS_URL, authHeaders, fetchWithTimeout } from '../config';

export type MemoryCategory =
  | 'people_relationships' | 'stable_facts_preferences' | 'routines_classifications'
  | 'goals_projects' | 'decisions_commitments' | 'time_bounded_events'
  | 'corrections_exclusions' | 'learned_beliefs';

export interface MemoryItem {
  id: string; // "assertion:<uuid>" | "belief:<id>"
  origin: 'assertion' | 'belief';
  rawId: string | number;
  category: MemoryCategory;
  statement: string;
  reason: string;
  observedAt: string | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  temporalLabel: string;
  status: string;
  confidence: number | null;
  eligibleForReasoning: boolean;
  supersedesId: string | null;
  retiredReason: string | null;
  actions: {
    canCorrect: boolean;
    canForget: boolean;
    canMarkTemporary: boolean;
    canConfirm: boolean;
    canViewSource: boolean;
  };
}

export interface MemoryProjection {
  active: MemoryItem[];
  historical: MemoryItem[];
}

const EMPTY: MemoryProjection = { active: [], historical: [] };

function urlFor(item: MemoryItem, path: string): string {
  return item.origin === 'belief' ? `${BELIEFS_URL}/${item.rawId}${path}` : `${MEMORY_URL}/assertions/${item.rawId}${path}`;
}

export function useMemory() {
  const [data, setData] = useState<MemoryProjection>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout(MEMORY_URL, { headers: authHeaders() }, 10000);
      if (!res.ok) { setLoadError(true); return; }
      const json = await res.json();
      setData({ active: json.active ?? [], historical: json.historical ?? [] });
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // A belief's Confirm/Forget map onto different HTTP verbs than an
  // assertion's — see routes/beliefs.js (POST /confirm, DELETE for forget)
  // vs routes/memory.js (POST /forget, POST /correct, POST /expire).
  const correct = useCallback(async (item: MemoryItem, text: string) => {
    const path = item.origin === 'belief' ? '' : '/correct';
    const method = item.origin === 'belief' ? 'PATCH' : 'POST';
    const body = item.origin === 'belief' ? { statement: text } : { text };
    const res = await fetchWithTimeout(urlFor(item, path), { method, headers: authHeaders(), body: JSON.stringify(body) }, 10000);
    if (res.ok) await load();
    return res.ok;
  }, [load]);

  const forget = useCallback(async (item: MemoryItem) => {
    const method = item.origin === 'belief' ? 'DELETE' : 'POST';
    const path = item.origin === 'belief' ? '' : '/forget';
    const res = await fetchWithTimeout(urlFor(item, path), { method, headers: authHeaders() }, 10000);
    if (res.ok) await load();
    return res.ok;
  }, [load]);

  const confirm = useCallback(async (item: MemoryItem) => {
    if (item.origin !== 'belief') return false; // no confirmation authority for assertions today
    const res = await fetchWithTimeout(`${BELIEFS_URL}/${item.rawId}/confirm`, { method: 'POST', headers: authHeaders() }, 10000);
    if (res.ok) await load();
    return res.ok;
  }, [load]);

  const markTemporary = useCallback(async (item: MemoryItem, effectiveEnd: string) => {
    if (item.origin !== 'assertion') return false;
    const res = await fetchWithTimeout(`${MEMORY_URL}/assertions/${item.rawId}/expire`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ effectiveEnd }),
    }, 10000);
    if (res.ok) await load();
    return res.ok;
  }, [load]);

  return { ...data, loading, loadError, load, correct, forget, confirm, markTemporary };
}
