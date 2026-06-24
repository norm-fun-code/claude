import { useState, useEffect, useCallback } from 'react';
import {
  CHAT_URL,
  CHAT_HISTORY_URL,
  CHAT_CLEAR_URL,
  CHAT_SAVE_URL,
  CHAT_CONVERSATIONS_URL,
  authHeaders,
  fetchWithTimeout,
} from '../config';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Conversation {
  id: number;
  title: string | null;
  saved_at: string | null;
  updated_at: string;
  message_count: number;
  first_message: string | null;
}

// Single source of truth for the "Ask NormOS" conversation. The backend persists
// the active thread (and its long-term memory), and lets you save threads, browse
// saved ones, resume, and delete them — all spanning one shared server history.
export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`${CHAT_HISTORY_URL}?limit=50`, { headers: authHeaders() }, 15000);
      const json = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(json.messages)) {
        setMessages(json.messages.map((m: any) => ({ role: m.role, content: m.content })));
      }
    } catch { /* history is best-effort */ }
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(CHAT_CONVERSATIONS_URL, { headers: authHeaders() }, 15000);
      const json = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(json.conversations)) setConversations(json.conversations);
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const send = useCallback(async (q: string) => {
    if (!q.trim() || loading) return;
    setMessages((prev) => [...prev, { role: 'user', content: q }]);
    setLoading(true);
    try {
      const res = await fetchWithTimeout(CHAT_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ question: q }),
      }, 90000);
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

  // Discard the active thread without saving.
  const clear = useCallback(async () => {
    setMessages([]);
    try {
      await fetchWithTimeout(CHAT_CLEAR_URL, { method: 'POST', headers: authHeaders() }, 15000);
    } catch { /* best-effort */ }
  }, []);

  // Archive the active thread to the sidebar, then start fresh.
  const save = useCallback(async () => {
    try {
      await fetchWithTimeout(CHAT_SAVE_URL, { method: 'POST', headers: authHeaders() }, 15000);
    } catch { /* best-effort */ }
    setMessages([]);
    loadConversations();
  }, [loadConversations]);

  // Resume a saved thread — it becomes the live one.
  const open = useCallback(async (id: number) => {
    try {
      const res = await fetchWithTimeout(`${CHAT_CONVERSATIONS_URL}/${id}/open`, { method: 'POST', headers: authHeaders() }, 15000);
      const json = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(json.messages)) {
        setMessages(json.messages.map((m: any) => ({ role: m.role, content: m.content })));
      }
    } catch { /* best-effort */ }
  }, []);

  const remove = useCallback(async (id: number) => {
    setConversations((prev) => prev.filter((c) => c.id !== id)); // optimistic
    try {
      await fetchWithTimeout(`${CHAT_CONVERSATIONS_URL}/${id}`, { method: 'DELETE', headers: authHeaders() }, 15000);
    } catch {
      loadConversations(); // revert by reloading on failure
    }
  }, [loadConversations]);

  const rename = useCallback(async (id: number, title: string) => {
    setConversations((prev) => prev.map((c) => c.id === id ? { ...c, title } : c)); // optimistic
    try {
      await fetchWithTimeout(`${CHAT_CONVERSATIONS_URL}/${id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ title }),
      }, 15000);
    } catch {
      loadConversations(); // revert on failure
    }
  }, [loadConversations]);

  return { messages, loading, conversations, send, clear, save, open, remove, rename, loadConversations };
}
