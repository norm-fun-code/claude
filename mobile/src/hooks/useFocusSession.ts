import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FOCUS_STORAGE_KEY, restoreFocus, type FocusSession } from '../lib/nextMove';

/** Only explicit transitions write; ticking never writes storage or life data. */
export function useFocusSession() {
  const [session, setSession] = useState<FocusSession | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef(Promise.resolve());
  const alive = useRef(true);
  async function restore() {
    try {
      const raw = await AsyncStorage.getItem(FOCUS_STORAGE_KEY);
      if (alive.current) { setSession(restoreFocus(raw)); setError(null); setReady(true); }
    } catch {
      if (alive.current) setError('Could not restore your session. Tap Retry to try again.');
    }
  }
  useEffect(() => {
    alive.current = true;
    void restore();
    return () => { alive.current = false; };
  }, []);
  function update(next: FocusSession | null) {
    if (!ready) return;
    setSession(next);
    // Serial writes prevent a slow pause from overwriting a later resume/end.
    queue.current = queue.current.then(async () => {
      try {
        if (next) await AsyncStorage.setItem(FOCUS_STORAGE_KEY, JSON.stringify(next));
        else await AsyncStorage.removeItem(FOCUS_STORAGE_KEY);
        if (alive.current) setError(null);
      } catch {
        if (alive.current) setError('This change could not be saved on this device. Tap Retry before leaving.');
      }
    });
  }
  return { session, ready, error, update, retry: () => { if (ready) update(session); else void restore(); } };
}
