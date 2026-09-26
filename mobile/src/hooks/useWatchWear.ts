import { useCallback, useEffect, useState } from 'react';
import { WATCH_WEAR_URL, authHeaders, fetchWithTimeout, localDateStr } from '../config';

/**
 * "Did I wear my Apple Watch today?"
 *
 * Wearing it is the default, and the hook starts in that state rather than in a
 * loading state — the common case is true, and a toggle that flickers or sits
 * disabled while it checks would be worse than one that is occasionally a
 * moment behind.
 *
 * `set` is optimistic for the same reason: the switch must move under the
 * finger. On failure it snaps back, because silently showing "not worn" while
 * the server still counts the day would be the one genuinely misleading
 * outcome.
 */
export function useWatchWear() {
  const [worn, setWorn] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fetched, setFetched] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`${WATCH_WEAR_URL}?day=${localDateStr()}`, { headers: authHeaders() }, 12000);
      if (res.ok) {
        const d = await res.json();
        if (typeof d?.worn === 'boolean') setWorn(d.worn);
        setFetched(true);
      }
    } catch {
      // Keep the default. A network blip must not make it look like the watch
      // was off, which would read as "today's activity has been discarded".
    }
  }, []);

  const set = useCallback(async (next: boolean) => {
    const previous = worn;
    setWorn(next);
    setSaving(true);
    try {
      const res = await fetchWithTimeout(
        WATCH_WEAR_URL,
        { method: 'POST', headers: authHeaders(), body: JSON.stringify({ day: localDateStr(), worn: next }) },
        12000
      );
      if (!res.ok) setWorn(previous);
    } catch {
      setWorn(previous);
    } finally {
      setSaving(false);
    }
  }, [worn]);

  useEffect(() => { refetch(); }, [refetch]);

  return { worn, set, saving, fetched, refetch };
}
