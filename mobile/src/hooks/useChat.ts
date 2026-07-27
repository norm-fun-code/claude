import { useState, useEffect, useCallback, useRef } from 'react';
import {
  CHAT_URL,
  CHAT_HISTORY_URL,
  CHAT_CLEAR_URL,
  CHAT_SAVE_URL,
  CHAT_CONVERSATIONS_URL,
  CHAT_CONFIRM_ACTION_URL,
  authHeaders,
  fetchWithTimeout,
} from '../config';
import { mapAskError, NETWORK_ERROR_MESSAGE } from '../lib/askError';
import type { AskResponse, ProposedAction } from '../lib/askResponse';
import { pendingConfirmations } from '../lib/askResponse';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Set on a failed turn's assistant bubble — lets the UI offer a distinct
      "retry" affordance instead of treating it as a normal answer. */
  error?: boolean;
  /** The structured AskResponse for this turn (assistant messages only) —
      intent/evidence/uncertainties/proposedActions. Only carried on the
      freshly-generated message (not reconstructed on reload from
      /chat/history, which persists plain text only). */
  askResponse?: AskResponse;
  /** Actions from this turn still awaiting an explicit confirm tap — a live
      view over askResponse.proposedActions that confirmAction() mutates
      directly, so a confirmed card disappears without a full re-fetch. */
  pendingActions?: ProposedAction[];
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

  // Deliberately NOT auto-loaded here: this hook is shared by both the
  // always-mounted quick-ask FAB (which should resume the live server thread)
  // and the embedded Ask tab (which unmounts/remounts on every tab switch and
  // should open fresh, not silently resume). Each caller loads explicitly —
  // see AskOverlay.tsx's mount effect.
  // Tracks the last question that failed, so `retry()` can resend it without
  // the caller having to hold onto the text itself.
  const lastFailedQuestionRef = useRef<string | null>(null);

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
        // json.code is the backend's sanitized, stable error code (e.g.
        // ask_truncated/ask_declined/ask_unavailable — see
        // backend/src/chat/ask.js's AskGenerationError and
        // errorHandler.js's additive `code` field) — never the raw
        // internal error text. mapAskError distinguishes these from a
        // generic status-only failure so the user isn't shown the same
        // undifferentiated message for every kind of backend failure.
        lastFailedQuestionRef.current = q;
        const { message } = mapAskError(res.status, json);
        setMessages((prev) => [...prev, { role: 'assistant', content: message, error: true }]);
        return;
      }
      lastFailedQuestionRef.current = null;
      const askResponse: AskResponse | undefined = json.askResponse;
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: json.answer || 'No answer.',
        askResponse,
        pendingActions: askResponse ? pendingConfirmations(askResponse) : undefined,
      }]);
    } catch {
      lastFailedQuestionRef.current = q;
      setMessages((prev) => [...prev, { role: 'assistant', content: NETWORK_ERROR_MESSAGE, error: true }]);
    } finally {
      setLoading(false);
    }
  }, [loading]);

  // Re-sends the question from the most recent failed turn, if any — the
  // "offer a retry" affordance for a truncated/declined/unavailable answer
  // (or a network failure) without the user having to retype it.
  const retry = useCallback(() => {
    const q = lastFailedQuestionRef.current;
    if (q) send(q);
  }, [send]);

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

  // Execute an action that needed explicit confirmation (a workout swap, a
  // new life chapter — chat/actionPolicy.js's CONFIRM_REQUIRED_ACTIONS).
  // Re-validates server-side against the same allowlist ask() itself uses;
  // never claims success client-side before the mutation actually lands —
  // the card only clears the action once the server confirms it executed.
  const confirmAction = useCallback(async (messageIndex: number, action: ProposedAction) => {
    try {
      const res = await fetchWithTimeout(CHAT_CONFIRM_ACTION_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ action: action.validatedPayload }),
      }, 20000);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        return { ok: false, message: json.message || 'Could not complete that action.' };
      }
      setMessages((prev) => prev.map((m, i) => {
        if (i !== messageIndex || !m.pendingActions) return m;
        return { ...m, pendingActions: m.pendingActions.filter((a) => a !== action) };
      }));
      return { ok: true, description: json.result?.description as string | undefined };
    } catch {
      return { ok: false, message: NETWORK_ERROR_MESSAGE };
    }
  }, []);

  return { messages, loading, conversations, send, retry, clear, save, open, remove, rename, confirmAction, loadConversations, loadHistory };
}
