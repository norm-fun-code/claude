import { useEffect, useState } from 'react';
import { CONTEXT_HISTORY_URL, authHeaders, fetchWithTimeout } from '../config';
import type { ContextTag, ContextNote } from '../components/viz/LineChart';

interface ContextHistoryResult {
  contextByDay: Record<string, ContextTag[]>;
  notesByDay: Record<string, ContextNote[]>;
}

// RecoveryCard and MetricDetailSheet both call this for the same `days`
// window — leaving and revisiting the Health tab re-mounts RecoveryCard and
// re-pulls the identical window. Cache by `days` for a short TTL, including
// the in-flight promise so concurrent callers share one request.
const CONTEXT_HISTORY_CACHE_MS = 3 * 60 * 1000;
const contextHistoryCache = new Map<number, { at: number; promise: Promise<ContextHistoryResult> }>();

function fetchContextHistory(days: number): Promise<ContextHistoryResult> {
  const hit = contextHistoryCache.get(days);
  if (hit && Date.now() - hit.at < CONTEXT_HISTORY_CACHE_MS) return hit.promise;
  const promise = fetchWithTimeout(`${CONTEXT_HISTORY_URL}?days=${days}`, { headers: authHeaders() })
    .then((r) => r.json())
    .then((d) => ({ contextByDay: d.history ?? {}, notesByDay: d.notes ?? {} }))
    .catch((err) => { contextHistoryCache.delete(days); throw err; });
  contextHistoryCache.set(days, { at: Date.now(), promise });
  return promise;
}

// Nightly tags + free-text notes per day, for the chart scrubber tooltip. Pass
// the same window the chart spans; `enabled` gates the fetch (e.g. a sheet that
// isn't open yet).
export function useContextHistory(days: number, enabled = true) {
  const [contextByDay, setContextByDay] = useState<Record<string, ContextTag[]>>({});
  const [notesByDay, setNotesByDay] = useState<Record<string, ContextNote[]>>({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchContextHistory(days)
      .then((d) => { if (!cancelled) { setContextByDay(d.contextByDay); setNotesByDay(d.notesByDay); } })
      .catch(() => { if (!cancelled) { setContextByDay({}); setNotesByDay({}); } });
    return () => { cancelled = true; };
  }, [days, enabled]);

  return { contextByDay, notesByDay };
}
