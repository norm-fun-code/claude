import { useState, useEffect, useCallback } from 'react';
import { CHAT_URL, CHAT_HISTORY_URL, CHAT_CLEAR_URL, authHeaders, fetchWithTimeout } from '../config';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Single source of truth for the "Ask NormOS" conversation. The backend persists
// the thread (and its long-term memory), so we only send the new question and the
// server reconstructs context. History loads on mount so the thread survives app
// restarts and is shared across every surface that uses this hook.
export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(`${CHAT_HISTORY_URL}?limit=50`, { headers: authHeaders() }, 15000);
        const json = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && Array.isArray(json.messages)) {
          setMessages(json.messages.map((m: any) => ({ role: m.role, content: m.content })));
        }
      } catch { /* history is best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const send = useCallback(async (q: string) => {
    if (!q.trim() || loading) return;
    setMessages((prev) => [...prev, { role: 'user', content: q }]);
    setLoading(true);
    try {
      const res = await fetchWithTimeout(CHAT_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ question: q }),
      }, 45000);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessages((prev) => [...prev, { role: 'assistant', content: `NormOS hit an error (${res.status}). Please try again in a moment.` }]);
        return;
      }
      setMessages((prev) => [...prev, { role: 'assistant', content: json.answer || 'No answer.' }]);
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Could not reach NormOS. Check your connection and try again.' }]);
    } finally {
      setLoading(false);
    }
  }, [loading]);

  const clear = useCallback(async () => {
    setMessages([]);
    try {
      await fetchWithTimeout(CHAT_CLEAR_URL, { method: 'POST', headers: authHeaders() }, 15000);
    } catch { /* best-effort */ }
  }, []);

  return { messages, loading, send, clear };
}
