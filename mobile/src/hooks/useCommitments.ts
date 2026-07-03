import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { COMMITMENTS_URL, authHeaders, fetchWithTimeout } from '../config';

export interface Commitment {
  id: number;
  title: string;
  detail: string | null;
  source: string;
  due_at: string | null;
  status: string;
  created_at: string;
}

// Open commitments (things you said you'd do) for the Today card. Refreshes on
// mount, on foreground, and on demand — a done/skip optimistically drops the row
// locally, then reconciles against the server response.
export function useCommitments() {
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout(COMMITMENTS_URL, { headers: authHeaders() }, 12000);
      if (res.ok) {
        const data = await res.json();
        setCommitments(Array.isArray(data?.commitments) ? data.commitments : []);
      }
    } catch {
      /* offline — keep prior state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refetch();
    });
    return () => sub.remove();
  }, [refetch]);

  const resolve = useCallback(async (id: number, how: 'done' | 'skip') => {
    // Optimistic: drop it now, restore on failure.
    const prev = commitments;
    setCommitments((cs) => cs.filter((c) => c.id !== id));
    try {
      const res = await fetchWithTimeout(`${COMMITMENTS_URL}/${id}/${how}`, {
        method: 'POST',
        headers: authHeaders(),
      }, 10000);
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setCommitments(prev); // put it back — the tap didn't land
    }
  }, [commitments]);

  return { commitments, loading, refetch, resolve };
}
