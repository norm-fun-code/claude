import { useEffect, useState } from 'react';
import { CONTEXT_HISTORY_URL, authHeaders, fetchWithTimeout } from '../config';
import type { ContextTag, ContextNote } from '../components/viz/LineChart';

// Nightly tags + free-text notes per day, for the chart scrubber tooltip. Pass
// the same window the chart spans; `enabled` gates the fetch (e.g. a sheet that
// isn't open yet).
export function useContextHistory(days: number, enabled = true) {
  const [contextByDay, setContextByDay] = useState<Record<string, ContextTag[]>>({});
  const [notesByDay, setNotesByDay] = useState<Record<string, ContextNote[]>>({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchWithTimeout(`${CONTEXT_HISTORY_URL}?days=${days}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { setContextByDay(d.history ?? {}); setNotesByDay(d.notes ?? {}); } })
      .catch(() => { if (!cancelled) { setContextByDay({}); setNotesByDay({}); } });
    return () => { cancelled = true; };
  }, [days, enabled]);

  return { contextByDay, notesByDay };
}
