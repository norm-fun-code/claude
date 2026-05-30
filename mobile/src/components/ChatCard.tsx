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
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import { CHAT_URL, authHeaders } from '../config';

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
  const [loading, setLoading] = useState(false);

  async function send(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setAnswer(null);
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ question: q }),
      });
      const json = await res.json();
      setAnswer(json.answer || json.error || 'No answer.');
    } catch {
      setAnswer('Could not reach NormOS. Is the backend running?');
    } finally {
      setLoading(false);
    }
  }

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
      {answer && <Text style={[styles.answer, { color: c.text }]}>{answer}</Text>}
    </View>
  );
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
  answer: { ...typography.body, marginTop: spacing.md },
});
