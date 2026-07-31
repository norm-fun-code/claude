import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { COMMITMENTS_URL, authHeaders, fetchWithTimeout } from '../config';
import { hidePendingCommitments, removeCommitment, restoreCommitment } from '../lib/commitmentState';

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
  const [resolvingIds, setResolvingIds] = useState<number[]>([]);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // React state alone is not enough for back-to-back taps: both async
  // closures can otherwise capture the same old array and restore it later.
  const commitmentsRef = useRef<Commitment[]>([]);
  const pendingIdsRef = useRef<Set<number>>(new Set());
  // Every mutation invalidates earlier GETs. Without this, a GET that began
  // before "done" can finish afterwards and put the now-closed row back.
  const fetchGenerationRef = useRef(0);

  const replaceCommitments = useCallback((next: Commitment[]) => {
    commitmentsRef.current = next;
    setCommitments(next);
  }, []);

  const updateCommitments = useCallback((fn: (current: Commitment[]) => Commitment[]) => {
    replaceCommitments(fn(commitmentsRef.current));
  }, [replaceCommitments]);

  const setPending = useCallback((id: number, pending: boolean) => {
    if (pending) pendingIdsRef.current.add(id);
    else pendingIdsRef.current.delete(id);
    setResolvingIds([...pendingIdsRef.current]);
  }, []);

  const refetch = useCallback(async () => {
    const generation = ++fetchGenerationRef.current;
    setLoading(true);
    try {
      const res = await fetchWithTimeout(COMMITMENTS_URL, { headers: authHeaders() }, 12000);
      if (!res.ok) return false;
      const data = await res.json();
      // A newer refresh or a mutation owns the state now. Never let this
      // older response overwrite it; filter rows still being resolved too.
      if (generation !== fetchGenerationRef.current) return false;
      const rows = Array.isArray(data?.commitments) ? data.commitments : [];
      replaceCommitments(hidePendingCommitments(rows, pendingIdsRef.current));
      return true;
    } catch {
      /* offline — keep prior state */
      return false;
    } finally {
      if (generation === fetchGenerationRef.current) setLoading(false);
    }
  }, [replaceCommitments]);

  useEffect(() => { refetch(); }, [refetch]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refetch();
    });
    return () => sub.remove();
  }, [refetch]);

  const resolve = useCallback(async (id: number, how: 'done' | 'skip') => {
    if (pendingIdsRef.current.has(id)) return false;
    const before = commitmentsRef.current;
    const originalIndex = before.findIndex((c) => c.id === id);
    const original = originalIndex >= 0 ? before[originalIndex] : null;
    if (!original) return false;

    setResolveError(null);
    // Invalidate a response that was already fetching the old open list.
    ++fetchGenerationRef.current;
    setPending(id, true);
    updateCommitments((current) => removeCommitment(current, id));
    try {
      const res = await fetchWithTimeout(`${COMMITMENTS_URL}/${id}/${how}`, {
        method: 'POST',
        headers: authHeaders(),
      }, 10000);
      if (!res.ok) throw new Error(String(res.status));
      // Reconcile from the source of truth after the write. If another
      // commitment is still pending, refetch filters it until that write ends.
      await refetch();
      return true;
    } catch {
      // A timeout may happen after the server committed. Read canonical state
      // before restoring the optimistic row; restoring first was how a
      // successful Done tap could visibly come back as open.
      // Unlike a successful mutation (where this row should remain hidden),
      // this reconciliation must let the canonical GET include the target so
      // we can distinguish "still open" from "the write actually landed".
      setPending(id, false);
      const reconciled = await refetch();
      if (reconciled) {
        const isStillOpen = commitmentsRef.current.some((c) => c.id === id);
        setResolveError(isStillOpen
          ? 'Couldn’t update that commitment. It is still open — try again.'
          : 'The update completed, but its confirmation was interrupted.');
        return !isStillOpen;
      } else {
        updateCommitments((current) => restoreCommitment(current, original, originalIndex));
        setResolveError('Couldn’t confirm the update. It is still shown as open — refresh before trying again.');
      }
      return false;
    } finally {
      setPending(id, false);
    }
  }, [refetch, setPending, updateCommitments]);

  return { commitments, loading, resolvingIds, resolveError, refetch, resolve };
}
