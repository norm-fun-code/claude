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

interface Props {
  /** Home-indicator height, so the launcher floats above the flush tab bar. */
  bottomInset?: number;
}

const SUGGESTIONS = [
  'Why was my focus lower last week?',
  'What habits predict my best weeks?',
  'What should I focus on this quarter?',
];

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Global "Ask NormOS" command bar: a floating button on every tab that opens a
// full conversation sheet. Save the current thread to the sidebar, browse saved
// ones, resume, or delete — all backed by the persistent server history.
export function AskOverlay({ bottomInset = 0 }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [question, setQuestion] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const { messages, loading, conversations, send, clear, save, open: openConvo, remove, rename, loadConversations } = useChat();
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (open && view === 'chat') requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, [messages.length, loading, open, view]);

  const submit = (q: string) => {
    if (!q.trim()) return;
    setQuestion('');
    send(q);
  };

  const showHistory = () => { loadConversations(); setView('history'); };
  const pickConversation = async (id: number) => { await openConvo(id); setView('chat'); };

  const startRename = (id: number, current: string) => {
    setEditingId(id);
    setEditTitle(current);
  };

  const commitRename = (id: number) => {
    if (editTitle.trim()) rename(id, editTitle.trim());
    setEditingId(null);
  };

  const md = markdownStyles(c);
  const empty = messages.length === 0;

  return (
    <>
      <Pressable
        onPress={() => { setView('chat'); setOpen(true); }}
        style={[styles.fab, { backgroundColor: c.accent, bottom: bottomInset + 70 }, shadow(isDark, 'bar')]}
        accessibilityLabel="Ask NormOS"
        accessibilityRole="button"
      >
        <Text style={styles.fabIcon}>✦</Text>
        <Text style={styles.fabText}>Ask</Text>
      </Pressable>

      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <KeyboardAvoidingView
          style={[styles.sheet, { backgroundColor: c.background }]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
        >
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: c.border }]}>
            {view === 'history' ? (
              <Pressable onPress={() => setView('chat')} hitSlop={8}>
                <Text style={[styles.headerBtn, { color: c.accent }]}>‹ Back</Text>
              </Pressable>
            ) : (
              <Pressable onPress={showHistory} hitSlop={8}>
                <Text style={[styles.headerBtn, { color: c.accent }]}>History</Text>
              </Pressable>
            )}
            <Text style={[styles.title, { color: c.text }]}>{view === 'history' ? 'Saved' : 'Ask NormOS'}</Text>
            <Pressable onPress={() => setOpen(false)} hitSlop={8}>
              <Text style={[styles.headerBtn, { color: c.accent }]}>Done</Text>
            </Pressable>
          </View>

          {view === 'history' ? (
            <ScrollView style={styles.flex} contentContainerStyle={styles.threadContent} keyboardShouldPersistTaps="handled">
              {conversations.length === 0 ? (
                <Text style={[styles.emptyHint, { color: c.subtext, marginTop: spacing.lg }]}>
                  No saved conversations yet. Tap "Save" in a chat to keep it here.
                </Text>
              ) : (
                conversations.map((conv) => {
                  const displayTitle = conv.title || conv.first_message || 'Conversation';
                  const isEditing = editingId === conv.id;
                  return (
                    <View key={conv.id} style={[styles.convRow, { borderBottomColor: c.border }]}>
                      <Pressable style={styles.convBody} onPress={() => !isEditing && pickConversation(conv.id)}>
                        {isEditing ? (
                          <TextInput
                            style={[styles.convTitleInput, { color: c.text, borderBottomColor: c.accent }]}
                            value={editTitle}
                            onChangeText={setEditTitle}
                            onSubmitEditing={() => commitRename(conv.id)}
                            onBlur={() => commitRename(conv.id)}
                            returnKeyType="done"
                            autoFocus
                            selectTextOnFocus
                          />
                        ) : (
                          <Text style={[styles.convTitle, { color: c.text }]} numberOfLines={1}>
                            {displayTitle}
                          </Text>
                        )}
                        <Text style={[styles.convMeta, { color: c.subtext }]}>
                          {fmtDate(conv.saved_at)} · {conv.message_count} message{conv.message_count === 1 ? '' : 's'}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => startRename(conv.id, displayTitle)}
                        hitSlop={10}
                        style={styles.rowAction}
                        accessibilityLabel="Rename conversation"
                      >
                        <Text style={[styles.rowActionIcon, { color: c.subtext }]}>✏️</Text>
                      </Pressable>
                      <Pressable onPress={() => remove(conv.id)} hitSlop={10} style={styles.rowAction} accessibilityLabel="Delete conversation">
                        <Text style={[styles.rowActionIcon, { color: c.subtext }]}>🗑</Text>
                      </Pressable>
                    </View>
                  );
                })
              )}
            </ScrollView>
          ) : (
            <>
              <ScrollView ref={scrollRef} style={styles.flex} contentContainerStyle={styles.threadContent} keyboardShouldPersistTaps="handled">
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

              {/* Save / Clear toolbar — only when there's something to act on. */}
              {!empty && (
                <View style={[styles.toolbar, { borderTopColor: c.border }]}>
                  <Pressable onPress={save} hitSlop={6} style={[styles.toolBtn, { backgroundColor: c.accentSoft }]}>
                    <Text style={[styles.toolBtnText, { color: c.accent }]}>＋ Save & start new</Text>
                  </Pressable>
                  <Pressable onPress={clear} hitSlop={6} style={styles.toolBtnGhost}>
                    <Text style={[styles.toolGhostText, { color: c.subtext }]}>Clear</Text>
                  </Pressable>
                </View>
              )}

              <View style={[styles.inputRow, { borderColor: c.border, backgroundColor: c.card }]}>
                <TextInput
                  ref={inputRef}
                  style={[styles.input, { color: c.text }]}
                  placeholder="Ask about your life…"
                  placeholderTextColor={c.subtext}
                  value={question}
                  onChangeText={setQuestion}
                  onSubmitEditing={() => submit(question)}
                  returnKeyType="send"
                />
                <Pressable onPress={() => submit(question)} style={[styles.send, { backgroundColor: c.accent }]}>
                  <Text style={styles.sendText}>Ask</Text>
                </Pressable>
              </View>
            </>
          )}
        </KeyboardAvoidingView>
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
  title: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
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
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  toolBtn: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.md },
  toolBtnText: { fontSize: 14, fontWeight: '700' },
  toolBtnGhost: { paddingHorizontal: spacing.sm, paddingVertical: 8 },
  toolGhostText: { fontSize: 14, fontWeight: '600' },
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
  convRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingVertical: spacing.md },
  convBody: { flex: 1, paddingRight: spacing.sm },
  convTitle: { fontSize: 15, fontWeight: '600' },
  convTitleInput: { fontSize: 15, fontWeight: '600', borderBottomWidth: 1, paddingVertical: 2, marginBottom: 2 },
  convMeta: { fontSize: 12, marginTop: 2 },
  rowAction: { paddingHorizontal: spacing.xs, paddingVertical: spacing.xs },
  rowActionIcon: { fontSize: 17 },
});
