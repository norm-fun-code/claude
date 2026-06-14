import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ActivityIndicator,
  Modal,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  useColorScheme,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { useChat } from '../hooks/useChat';

const SUGGESTIONS = [
  'Why was my focus lower last week?',
  'What habits predict my best weeks?',
  'What should I focus on this quarter?',
];

interface Props {
  /** Home-indicator height, so the launcher floats above the flush tab bar. */
  bottomInset?: number;
}

// Global "Ask NormOS" command bar: a floating button on every tab that opens a
// full conversation sheet — the chief-of-staff is always one gesture away,
// instead of buried in a tab. Backed by the persistent server thread, so the
// conversation is the same one everywhere.
export function AskOverlay({ bottomInset = 0 }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const { messages, loading, send, clear } = useChat();
  const scrollRef = useRef<ScrollView>(null);

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    if (open) requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, [messages.length, loading, open]);

  const submit = (q: string) => {
    if (!q.trim()) return;
    setQuestion('');
    send(q);
  };

  const md = markdownStyles(c);
  const empty = messages.length === 0;

  return (
    <>
      {/* Floating launcher — sits above the tab bar on every screen. */}
      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.fab, { backgroundColor: c.accent, bottom: bottomInset + 70 }, shadow(isDark, 'bar')]}
        accessibilityLabel="Ask NormOS"
        accessibilityRole="button"
      >
        <Text style={styles.fabIcon}>✦</Text>
        <Text style={styles.fabText}>Ask</Text>
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View style={[styles.sheet, { backgroundColor: c.background }]}>
          <View style={[styles.header, { borderBottomColor: c.border }]}>
            <Text style={[styles.title, { color: c.text }]}>Ask NormOS</Text>
            <View style={styles.headerActions}>
              {!empty && (
                <Pressable onPress={clear} hitSlop={8}>
                  <Text style={[styles.headerBtn, { color: c.subtext }]}>Clear</Text>
                </Pressable>
              )}
              <Pressable onPress={() => setOpen(false)} hitSlop={8}>
                <Text style={[styles.headerBtn, { color: c.accent }]}>Done</Text>
              </Pressable>
            </View>
          </View>

          <KeyboardAvoidingView
            style={styles.flex}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 12 : 0}
          >
            <ScrollView
              ref={scrollRef}
              style={styles.flex}
              contentContainerStyle={styles.threadContent}
              keyboardShouldPersistTaps="handled"
            >
              {empty && !loading && (
                <View style={styles.emptyState}>
                  <Text style={[styles.emptyTitle, { color: c.text }]}>Ask about your life</Text>
                  <Text style={[styles.emptyHint, { color: c.subtext }]}>
                    Answered from your own data, habits, and library — and it remembers what you've discussed.
                  </Text>
                  <View style={styles.suggestions}>
                    {SUGGESTIONS.map((s) => (
                      <Pressable key={s} onPress={() => submit(s)} style={[styles.chip, { backgroundColor: c.accentSoft }]}>
                        <Text style={[styles.chipText, { color: c.accent }]}>{s}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}

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
                    <Markdown style={md}>{m.content}</Markdown>
                  )}
                </View>
              ))}

              {loading && <ActivityIndicator color={c.accent} style={{ marginTop: spacing.md }} />}
            </ScrollView>

            <View style={[styles.inputRow, { borderColor: c.border, backgroundColor: c.card }]}>
              <TextInput
                style={[styles.input, { color: c.text }]}
                placeholder="Ask about your life…"
                placeholderTextColor={c.subtext}
                value={question}
                onChangeText={setQuestion}
                onSubmitEditing={() => submit(question)}
                returnKeyType="send"
                autoFocus
              />
              <Pressable onPress={() => submit(question)} style={[styles.send, { backgroundColor: c.accent }]}>
                <Text style={styles.sendText}>Ask</Text>
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </>
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
  flex: { flex: 1 },
  fab: {
    position: 'absolute',
    right: spacing.md,
    // bottom set inline (bottomInset + 70) so it clears the flush tab bar
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderRadius: 28,
  },
  fabIcon: { color: '#fff', fontSize: 16, fontWeight: '700' },
  fabText: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 0.2 },
  sheet: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
  },
  title: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerBtn: { fontSize: 15, fontWeight: '600' },
  threadContent: { padding: spacing.md, paddingBottom: spacing.lg },
  emptyState: { paddingTop: spacing.lg, gap: spacing.sm },
  emptyTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  emptyHint: { fontSize: 14, lineHeight: 21 },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  chip: { paddingHorizontal: spacing.sm + 2, paddingVertical: 8, borderRadius: 18 },
  chipText: { fontSize: 13, fontWeight: '500' },
  bubble: { borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: 6, marginTop: spacing.sm, maxWidth: '92%' },
  userText: { ...typography.body, fontSize: 15 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  input: { flex: 1, ...typography.body, fontSize: 16, paddingVertical: spacing.sm },
  send: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md },
  sendText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
