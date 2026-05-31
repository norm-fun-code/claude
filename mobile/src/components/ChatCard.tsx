import React, { useState } from 'react';
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
import { CHAT_URL, authHeaders } from '../config';

interface Source { title: string | null; author: string | null; url: string | null }

const SUGGESTIONS = [
  'Why was my focus lower last week?',
  'What habits predict my best weeks?',
  'What should I focus on this quarter?',
];

// Ask NormOS anything about your life — answered from your own data + library.
export function ChatCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(false);

  async function send(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setAnswer(null);
    setSources([]);
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ question: q }),
      });
      const json = await res.json();
      setAnswer(json.answer || json.error || 'No answer.');
      setSources(Array.isArray(json.sources) ? json.sources : []);
    } catch {
      setAnswer('Could not reach NormOS. Is the backend running?');
    } finally {
      setLoading(false);
    }
  }

  const md = markdownStyles(c);

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="💬" title="Ask NormOS" preserveCase />

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
        <Pressable
          onPress={() => send(question)}
          style={[styles.send, { backgroundColor: c.accent }]}
        >
          <Text style={styles.sendText}>Ask</Text>
        </Pressable>
      </View>

      {!answer && !loading && (
        <View style={styles.suggestions}>
          {SUGGESTIONS.map((s) => (
            <Pressable
              key={s}
              onPress={() => {
                setQuestion(s);
                send(s);
              }}
              style={[styles.chip, { backgroundColor: c.accentSoft }]}
            >
              <Text style={[styles.chipText, { color: c.accent }]}>{s}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {loading && <ActivityIndicator color={c.accent} style={{ marginTop: spacing.sm }} />}
      {answer && (
        <View style={styles.answer}>
          <Markdown style={md}>{answer}</Markdown>
          {sources.length > 0 && (
            <View style={[styles.sources, { borderTopColor: c.border }]}>
              <Text style={[styles.sourcesLabel, { color: c.subtext }]}>SOURCES</Text>
              {sources.map((s, i) => (
                <Text key={i} style={[styles.sourceItem, { color: c.subtext }]} numberOfLines={2}>
                  ({i + 1}) {s.title || 'Untitled'}{s.author ? ` — ${s.author}` : ''}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}
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
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.md,
    paddingLeft: spacing.sm,
    gap: spacing.sm,
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
  answer: { marginTop: spacing.md },
  sources: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1 },
  sourcesLabel: { ...typography.label, fontSize: 9, marginBottom: 4 },
  sourceItem: { fontSize: 12, lineHeight: 17, marginBottom: 2 },
});
