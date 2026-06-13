import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ActivityIndicator,
  useColorScheme,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import {
  CHAT_URL,
  CHAT_HISTORY_URL,
  CHAT_CLEAR_URL,
  authHeaders,
  fetchWithTimeout,
} from '../config';

interface Source { title: string | null; author: string | null; url: string | null }
interface Message { role: 'user' | 'assistant'; content: string; sources?: Source[] }

const SUGGESTIONS = [
  'Why was my focus lower last week?',
  'What habits predict my best weeks?',
  'What should I focus on this quarter?',
];

// Ask NormOS anything about your life — answered from your own data + library.
// Conversational + persistent: prior turns load on open and continuity survives
// app restarts (the backend remembers the thread).
export function ChatCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);

  // Load prior conversation on mount so the thread is there when you open the app.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithTimeout(`${CHAT_HISTORY_URL}?limit=50`, { headers: authHeaders() }, 15000);
        const json = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(json.messages)) {
          setMessages(
            json.messages.map((m: any) => ({ role: m.role, content: m.content, sources: m.sources ?? [] }))
          );
        }
      } catch { /* history is best-effort */ }
    })();
  }, []);

  const send = useCallback(async (q: string) => {
    if (!q.trim() || loading) return;
    setQuestion('');
    setMessages((prev) => [...prev, { role: 'user', content: q }]);
    setLoading(true);
    try {
      // The server loads its own memory, so we only send the new question.
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
      setMessages((prev) => [...prev, { role: 'assistant', content: json.answer || 'No answer.', sources: Array.isArray(json.sources) ? json.sources : [] }]);
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

  const md = markdownStyles(c);
  const empty = messages.length === 0;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={styles.headerRow}>
        <SectionHeader emoji="💬" title="Ask NormOS" preserveCase />
        {!empty && (
          <Pressable onPress={clear} hitSlop={8}>
            <Text style={[styles.clear, { color: c.subtext }]}>Clear</Text>
          </Pressable>
        )}
      </View>

      {/* Conversation thread */}
      {messages.map((m, i) => (
        <View
          key={i}
          style={[
            styles.bubble,
            m.role === 'user'
              ? { backgroundColor: c.accentSoft, alignSelf: 'flex-end' }
              : { backgroundColor: 'transparent', alignSelf: 'stretch' },
          ]}
        >
          {m.role === 'user' ? (
            <Text style={[styles.userText, { color: c.text }]}>{m.content}</Text>
          ) : (
            <>
              <Markdown style={md}>{m.content}</Markdown>
              {!!m.sources?.length && (
                <View style={[styles.sources, { borderTopColor: c.border }]}>
                  <Text style={[styles.sourcesLabel, { color: c.subtext }]}>SOURCES</Text>
                  {m.sources.map((s, j) => (
                    <Text key={j} style={[styles.sourceItem, { color: c.subtext }]} numberOfLines={2}>
                      ({j + 1}) {s.title || 'Untitled'}{s.author ? ` — ${s.author}` : ''}
                    </Text>
                  ))}
                </View>
              )}
            </>
          )}
        </View>
      ))}

      <View style={[styles.inputRow, { borderColor: c.border }]}>
        <TextInput
          style={[styles.input, { color: c.text }]}
          placeholder="Ask about your life…"
          placeholderTextColor={c.subtext}
          value={question}
          onChangeText={setQuestion}
          onSubmitEditing={() => send(question)}
          returnKeyType="send"
        />
        <Pressable onPress={() => send(question)} style={[styles.send, { backgroundColor: c.accent }]}>
          <Text style={styles.sendText}>Ask</Text>
        </Pressable>
      </View>

      {empty && !loading && (
        <View style={styles.suggestions}>
          {SUGGESTIONS.map((s) => (
            <Pressable
              key={s}
              onPress={() => send(s)}
              style={[styles.chip, { backgroundColor: c.accentSoft }]}
            >
              <Text style={[styles.chipText, { color: c.accent }]}>{s}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {loading && <ActivityIndicator color={c.accent} style={{ marginTop: spacing.sm }} />}
    </View>
  );
}

function markdownStyles(c: ReturnType<typeof getColors>) {
  return {
    body: { color: c.text, fontSize: 15, lineHeight: 22 },
    heading1: { color: c.text, fontSize: 19, fontWeight: '700', marginTop: 8, marginBottom: 4 },
    heading2: { color: c.text, fontSize: 17, fontWeight: '700', marginTop: 8, marginBottom: 4 },
    heading3: { color: c.text, fontSize: 15, fontWeight: '700', marginTop: 6, marginBottom: 2 },
    strong: { fontWeight: '700', color: c.text },
    em: { fontStyle: 'italic' },
    bullet_list: { marginVertical: 2 },
    ordered_list: { marginVertical: 2 },
    list_item: { marginVertical: 2 },
    paragraph: { marginTop: 0, marginBottom: 8 },
    link: { color: c.accent },
    code_inline: { backgroundColor: c.accentSoft, color: c.text, borderRadius: 4, paddingHorizontal: 4 },
    hr: { backgroundColor: c.border, height: 1, marginVertical: 8 },
  } as any;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  clear: { fontSize: 13, fontWeight: '600' },
  bubble: {
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    marginTop: spacing.sm,
    maxWidth: '92%',
  },
  userText: { ...typography.body, fontSize: 15 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.md,
    paddingLeft: spacing.sm,
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  input: { flex: 1, ...typography.body, paddingVertical: spacing.sm },
  send: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopRightRadius: radius.md,
    borderBottomRightRadius: radius.md,
  },
  sendText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  chip: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: 16 },
  chipText: { fontSize: 12, fontWeight: '500' },
  sources: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1 },
  sourcesLabel: { ...typography.label, fontSize: 9, marginBottom: 4 },
  sourceItem: { fontSize: 12, lineHeight: 17, marginBottom: 2 },
});
