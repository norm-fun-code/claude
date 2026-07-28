import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ActivityIndicator,
  Modal,
  ScrollView,
  Keyboard,
  Platform,
  useColorScheme,
  Alert,
  AppState,
  type AppStateStatus as RNAppStateStatus,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  FadeInDown,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { getColors, spacing, radius, typography, shadow, withAlpha } from '../theme';
import { useChat } from '../hooks/useChat';
import { API_BASE, CONSOLIDATE_URL, VOICE_ASK_URL, REALTIME_VOICE_ENABLED, authHeaders, fetchWithTimeout } from '../config';
import { buildSessionContext, createSessionId, type VoiceTab, type VoiceSelection } from '../lib/voiceCoordinator';
import { voiceAvailable, ensureMicPermission, startRecording, stopRecording, playBase64, stopPlayback } from '../lib/voice';
import { realtimeVoiceAvailable } from '../lib/realtimeVoice';
import { TalkOverlay } from './TalkOverlay';
import { buildAskSuggestions, type SnapData, type AskSuggestion } from '../lib/askSuggestions';
import { intentLabel, type ProposedAction } from '../lib/askResponse';
import { MemoryScreen } from './MemoryScreen';

export interface AskOverlayHandle {
  /** Open the overlay, optionally pre-filling the input with a question.
      `starters` are context-aware one-tap questions (built by the caller from
      whatever screen the user summoned Ask from) shown as chips above the
      input — the chief of staff arrives already knowing what you're looking at. */
  openWith: (question?: string, starters?: string[]) => void;
}

interface Props {
  /** Home-indicator height, so the launcher floats above the flush tab bar. */
  bottomInset?: number;
  /** Render as a full-screen tab (no FAB, no Modal wrapper, always visible). */
  embedded?: boolean;
  /** Pre-fill the question input when navigating here programmatically. */
  initialQuestion?: string;
  /** Modal mode without the floating launcher — summoned only via the ref
      (openWith), e.g. by long-pressing the Ask tab from anywhere in the app. */
  hideFab?: boolean;
  /** One-tap starter questions to seed when the FAB is tapped — same
      context-aware set the long-press-the-Ask-tab gesture uses. */
  contextStarters?: string[];
  /** The unified voice-session contract's inputs (chat/voiceCoordinator.ts)
   *  — which tab the user is on, the briefing snapshot they're looking at,
   *  and a specific card/insight/commitment they've selected, if any. Sent
   *  on every push-to-talk and Realtime session so "why is this yellow" /
   *  "mark this done" bind to a stable canonical record, never guessed from
   *  text. All optional — omitting them just means no selection context. */
  activeTab?: VoiceTab;
  snapshotId?: string | null;
  snapshotVersion?: number | null;
  voiceSelection?: VoiceSelection | null;
  /** A voice-driven action actually executed — the caller should refresh
   *  whatever canonical surfaces (briefing/health/etc) that action affects. */
  onVoiceActionExecuted?: (description: string) => void;
}

const METRICS: Record<string, { label: string; source: string }> = {
  'health:hrv':         { label: 'HRV',              source: 'Eight Sleep & Apple Health' },
  'health:sleep_hours': { label: 'Sleep duration',   source: 'Eight Sleep & Apple Health' },
  'health:sleep_score': { label: 'Sleep score',      source: 'Eight Sleep & Apple Health' },
  'health:resting_hr':  { label: 'Resting HR',       source: 'Eight Sleep & Apple Health' },
  'habits:exercise':    { label: 'Exercise',         source: 'Daily check-in' },
  'habits:eat_healthy': { label: 'Eating healthy',   source: 'Daily check-in' },
  'wellbeing:mood':     { label: 'Mood',             source: 'Daily check-in' },
  'wellbeing:energy':   { label: 'Energy',           source: 'Daily check-in' },
  'wellbeing:focus':    { label: 'Focus',            source: 'Daily check-in' },
};

type ExpProposal = {
  hypothesis: string;
  metric: string;
  lever: string;
  expected: string;
  protocol: string;
  testDays: number;
};
type ExpState =
  | null
  | 'loading'
  | { notActionable: true; reason: string }
  | ExpProposal
  | { started: true };

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Global "Ask NormOS" command bar: a floating button on every tab that opens a
// full conversation sheet. Save the current thread to the sidebar, browse saved
// ones, resume, or delete — all backed by the persistent server history.
export const AskOverlay = forwardRef<AskOverlayHandle, Props>(function AskOverlay({ bottomInset = 0, embedded = false, initialQuestion, hideFab = false, contextStarters, activeTab = 'ask', snapshotId = null, snapshotVersion = null, voiceSelection = null, onVoiceActionExecuted }, ref) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [open, setOpen] = useState(false);
  // 'memory' — product audit rec #6: a separate, first-class surface for
  // durable structured knowledge (context_assertions/beliefs), distinct from
  // 'history' (past Ask conversation transcripts). Neither view's delete/
  // forget action touches the other's data — see MemoryScreen.tsx and
  // useMemory.ts.
  const [view, setView] = useState<'chat' | 'history' | 'memory'>('chat');
  const fabScale = useSharedValue(1);
  const fabAnimStyle = useAnimatedStyle(() => ({ transform: [{ scale: fabScale.value }] }));
  const [question, setQuestion] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const { messages, loading, conversations, send, retry, clear, save, open: openConvo, remove, rename, confirmAction, loadConversations, loadHistory } = useChat();
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const [kbHeight, setKbHeight] = useState(0);
  const [expState, setExpState] = useState<ExpState>(null);
  const [expDays, setExpDays] = useState<14 | 21 | 28>(14);
  const [expStarting, setExpStarting] = useState(false);
  const [snapshot, setSnapshot] = useState<SnapData | null>(null);
  // Context-aware one-tap questions for the current summon (quick-ask only).
  const [starters, setStarters] = useState<string[]>([]);
  // Push-to-talk: hold the mic, speak, release → transcript + spoken answer.
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'thinking' | 'error'>('idle');
  // Once a voice turn has happened, the idle mic invites a follow-up instead of
  // a cold "ask me anything" — the conversation is already warm, and you can
  // hold the mic again the instant the reply starts playing (startRecording()
  // interrupts playback), no need to wait it out.
  const [hadVoiceTurn, setHadVoiceTurn] = useState(false);
  // Live conversation mode (OpenAI Realtime) — a separate full-screen modal,
  // opened from a control next to the old push-to-talk mic. Old path stays
  // the default entry point; this is additive, not a replacement, until the
  // native module has been proven in a real build.
  const [talkOpen, setTalkOpen] = useState(false);
  const showLiveEntry = REALTIME_VOICE_ENABLED && realtimeVoiceAvailable;

  // One stable sessionId per mount of this overlay — every push-to-talk turn
  // and the live Talk session correlate under it (backend's realtimeMetrics
  // ledger, the voice idempotency cache). Rebuilt fresh (not memoized) at
  // each call site below so `localDateTime` is always the actual current
  // moment, not a stale value captured at mount.
  const voiceSessionIdRef = useRef(createSessionId());
  function currentSessionContext() {
    return buildSessionContext({
      tab: activeTab, snapshotId, snapshotVersion, selection: voiceSelection,
      sessionId: voiceSessionIdRef.current,
    });
  }

  async function voicePressIn() {
    if (voiceState !== 'idle') return;
    if (!(await ensureMicPermission())) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await startRecording();
      setVoiceState('recording');
    } catch { setVoiceState('idle'); }
  }

  async function voicePressOut() {
    if (voiceState !== 'recording') return;
    setVoiceState('thinking');
    try {
      const rec = await stopRecording();
      if (!rec) { setVoiceState('idle'); return; }
      Haptics.selectionAsync();
      const res = await fetchWithTimeout(VOICE_ASK_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ audio: rec.base64, mime: rec.mime, ...currentSessionContext() }),
      }, 90000);
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data = await res.json();
      // The server persisted both turns to the shared thread — re-sync the view.
      await loadHistory();
      if (data.action?.done) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        if (data.action.description) onVoiceActionExecuted?.(data.action.description);
      }
      if (data.audio) playBase64(data.audio, data.audioMime || 'audio/wav').catch(() => {});
      setHadVoiceTurn(true);
      setVoiceState('idle');
    } catch {
      // Was a silent fail — the thread simply didn't gain a turn, indistinguishable
      // from "nothing was said," which is exactly what a live user hit reporting
      // a voice-logged action that "didn't even register at all." Same fix as
      // BriefCard's voice answer path: a visible error + haptic instead, and the
      // mic is immediately usable again to retry (auto-reverts after a beat).
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      setVoiceState('error');
      setTimeout(() => setVoiceState((s) => (s === 'error' ? 'idle' : s)), 2500);
    }
  }

  useImperativeHandle(ref, () => ({
    openWith(question?: string, starters?: string[]) {
      setView('chat'); // never reopen on the History/Memory screen
      setOpen(true);
      setStarters(starters ?? []); // refresh per summon so stale context never lingers
      if (question) setQuestion(question);
    },
  }));

  // In embedded mode, pre-fill when a question is pushed from outside (e.g. Wealth tab button).
  useEffect(() => {
    if (embedded && initialQuestion) setQuestion(initialQuestion);
  }, [embedded, initialQuestion]);

  // Backgrounding mid-recording (or mid-reply-playback) previously left
  // nothing to notice — the mic/playback simply kept running with no
  // visible UI. Stop both on background/inactive, the same rule
  // voiceAppState.ts's shouldStopForAppState encodes for the live Talk
  // session, applied here to the push-to-talk path.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: RNAppStateStatus) => {
      if (next !== 'background' && next !== 'inactive') return;
      if (voiceState === 'recording') { stopRecording().catch(() => {}); setVoiceState('idle'); }
      stopPlayback().catch(() => {});
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceState]);

  useEffect(() => {
    // The global quick-ask instance stays mounted (closed) app-wide — don't
    // let it re-render on every keyboard event from unrelated screens.
    if (!open && !embedded) return;
    const showEv = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEv = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEv, (e) => setKbHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEv, () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, [open, embedded]);

  // Load snapshot + conversations when the overlay opens (or on mount if embedded).
  useEffect(() => {
    if (!open && !embedded) return;
    if (!embedded) {
      // The quick-ask instance stays mounted between summons — re-sync the shared
      // server thread on each open so it never shows a stale conversation.
      loadHistory();
    } else {
      // The embedded Ask tab unmounts/remounts on every tab switch — archive
      // whatever's on the shared active thread (a safe no-op if it's already
      // empty) and start fresh, rather than silently resuming an old
      // conversation. History stays reachable via the Saved list.
      save();
    }
    loadConversations();
    (async () => {
      try {
        const res = await fetchWithTimeout(CONSOLIDATE_URL, { headers: authHeaders() }, 8000);
        if (res.ok) { const j = await res.json(); setSnapshot(j.snapshot ?? null); }
      } catch {}
    })();
  }, [open, embedded]);

  useEffect(() => {
    if (open && view === 'chat') requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, [messages.length, loading, open, view, expState]);

  const submit = (q: string) => {
    if (!q.trim()) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setQuestion('');
    setStarters([]); // context chips served their purpose once anything is asked
    send(q);
  };

  const clearChat = () => { setExpState(null); setHadVoiceTurn(false); clear(); };
  const saveChat = () => { setExpState(null); save(); };

  const extractExperiment = async () => {
    if (expState !== null) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setExpState('loading');
    try {
      const res = await fetchWithTimeout(
        `${API_BASE}/api/chat/extract-experiment`,
        { method: 'POST', headers: authHeaders(), body: JSON.stringify({ messages }) },
        30000,
      );
      if (!res.ok) { setExpState(null); return; }
      const data = await res.json();
      if (data.notActionable) {
        setExpState(data as { notActionable: true; reason: string });
        setTimeout(() => setExpState(null), 4000);
      } else {
        setExpDays((([14, 21, 28].includes(data.testDays) ? data.testDays : 14) as 14 | 21 | 28));
        setExpState(data as ExpProposal);
      }
    } catch { setExpState(null); }
  };

  const startExperiment = async () => {
    if (expStarting || expState === null || expState === 'loading' || 'notActionable' in (expState as object) || 'started' in (expState as object)) return;
    const proposal = expState as ExpProposal;
    setExpStarting(true);
    try {
      const r1 = await fetchWithTimeout(`${API_BASE}/api/experiments`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify(proposal),
      });
      if (!r1.ok) { setExpStarting(false); return; }
      const { id } = await r1.json();
      if (!id) { setExpStarting(false); return; }
      await fetchWithTimeout(`${API_BASE}/api/experiments/${id}/start`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ testDays: expDays }),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setExpState({ started: true });
      setTimeout(() => setExpState(null), 5000);
    } catch { } finally { setExpStarting(false); }
  };

  const showHistory = () => { setView('history'); };
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

  const chatSheet = (
    <View style={[styles.sheet, { backgroundColor: c.background, paddingBottom: kbHeight }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        {view === 'chat' ? (
          <View style={styles.headerLeftGroup}>
            <Pressable onPress={showHistory} hitSlop={8} accessibilityRole="button" accessibilityLabel="Conversation history">
              <Text style={[styles.headerBtn, { color: c.accent }]}>History</Text>
            </Pressable>
            <Pressable onPress={() => setView('memory')} hitSlop={8} accessibilityRole="button" accessibilityLabel="What NormOS knows">
              <Text style={[styles.headerBtn, { color: c.accent }]}>Memory</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={() => setView('chat')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back to conversation">
            <Text style={[styles.headerBtn, { color: c.accent }]}>‹ Back</Text>
          </Pressable>
        )}
        <Text style={[styles.title, { color: c.text }]}>
          {view === 'history' ? 'History' : view === 'memory' ? 'Memory' : 'Ask NormOS'}
        </Text>
        {embedded ? (
          <View style={{ width: 44 }} />
        ) : (
          <Pressable onPress={() => setOpen(false)} hitSlop={8}>
            <Text style={[styles.headerBtn, { color: c.accent }]}>Done</Text>
          </Pressable>
        )}
      </View>

          {view === 'memory' ? (
            <MemoryScreen />
          ) : view === 'history' ? (
            <ScrollView style={styles.flex} contentContainerStyle={styles.threadContent} keyboardShouldPersistTaps="handled">
              {conversations.length === 0 ? (
                <Text style={[styles.emptyHint, { color: c.subtext, marginTop: spacing.lg }]}>
                  No saved conversations yet. Tap "Save" in a chat to keep it here. Deleting a
                  conversation only removes this transcript — anything NormOS remembers about
                  you (preferences, standing facts) stays intact.
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
                            autoCorrect
                            spellCheck
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
                      <Pressable
                        onPress={() => {
                          // Deletion is deliberate, not a stray tap: this only removes
                          // the transcript, never any durable fact NormOS remembers
                          // (preferences/standing facts live in a separate memory
                          // system, untouched by conversation deletion).
                          Alert.alert(
                            'Delete conversation?',
                            'This removes the transcript. Anything NormOS remembers about you stays intact.',
                            [
                              { text: 'Cancel', style: 'cancel' },
                              { text: 'Delete', style: 'destructive', onPress: () => remove(conv.id) },
                            ],
                          );
                        }}
                        hitSlop={10}
                        style={styles.rowAction}
                        accessibilityRole="button"
                        accessibilityLabel="Delete conversation"
                      >
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
                      Uses your connected data and current NormOS memory to answer, decide, and act.
                    </Text>
                    <View style={styles.suggestions}>
                      {/* Prefer the context-aware starters seeded by whichever tab this
                          was summoned from — they're the whole point of a per-screen
                          mic. Only fall back to the generic snapshot-derived list when
                          none were passed in (e.g. opened plain from the Ask tab). Every
                          suggestion is recomputed from the CURRENT snapshot on each open
                          (never cached), so one whose underlying condition no longer
                          holds naturally stops being offered — see lib/askSuggestions.ts. */}
                      {(starters.length > 0
                        ? starters.map((s): AskSuggestion => ({ text: s, intent: 'understand' }))
                        : buildAskSuggestions(snapshot)
                      ).map((s) => (
                        <Pressable key={s.text} onPress={() => submit(s.text)} style={[styles.chip, { borderColor: c.border, backgroundColor: c.card }]}>
                          {starters.length === 0 && (
                            <Text style={[styles.chipBadge, { color: c.accent, borderColor: c.accent }]}>{intentLabel(s.intent).toUpperCase()}</Text>
                          )}
                          <Text style={[styles.chipText, { color: c.text }]} numberOfLines={2}>{s.text}</Text>
                          <Text style={[styles.chipArrow, { color: c.subtext }]}>›</Text>
                        </Pressable>
                      ))}
                    </View>
                    {conversations.length > 0 && (
                      <Pressable
                        onPress={() => pickConversation(conversations[0].id)}
                        style={[styles.lastConvRow, { borderTopColor: c.border }]}
                      >
                        <Text style={[styles.lastConvLabel, { color: c.subtext }]}>Continue last conversation · </Text>
                        <Text style={[styles.lastConvTitle, { color: c.accent }]} numberOfLines={1}>
                          {conversations[0].title || conversations[0].first_message || 'Conversation'}
                        </Text>
                        <Text style={[styles.chipArrow, { color: c.subtext }]}>›</Text>
                      </Pressable>
                    )}
                  </View>
                )}

                {messages.map((m, i) => (
                  <React.Fragment key={i}>
                    <Animated.View
                      entering={FadeInDown.duration(220).springify().damping(18)}
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
                    </Animated.View>
                    {/* Action preview + confirm card: a meaningful, cross-surface-
                        visible mutation (a workout swap, a new life chapter — see
                        backend/src/chat/actionPolicy.js) is proposed here, NOT
                        already applied. Nothing changes until the user taps Confirm,
                        and the card only clears once the server confirms the write
                        actually succeeded. */}
                    {m.role === 'assistant' && m.pendingActions?.map((pa) => {
                      const key = `${i}:${pa.actionType}:${pa.title}`;
                      return (
                        <Animated.View
                          key={key}
                          entering={FadeInDown.duration(220).springify().damping(18)}
                          style={[styles.actionCard, { backgroundColor: c.card, borderColor: c.accent }]}
                        >
                          <Text style={[styles.actionLabel, { color: c.subtext }]}>PROPOSED ACTION</Text>
                          <Text style={[styles.actionTitle, { color: c.text }]}>{pa.title}</Text>
                          {!!pa.preview && <Text style={[styles.actionPreview, { color: c.subtext }]}>{pa.preview}</Text>}
                          <View style={styles.actionBtnRow}>
                            <Pressable
                              disabled={confirmingKey === key}
                              onPress={async () => {
                                setConfirmingKey(key);
                                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                                const outcome = await confirmAction(i, pa);
                                setConfirmingKey(null);
                                Haptics.notificationAsync(
                                  outcome.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error
                                ).catch(() => {});
                              }}
                              style={[styles.actionConfirmBtn, { backgroundColor: c.accent, opacity: confirmingKey === key ? 0.6 : 1 }]}
                              accessibilityRole="button"
                              accessibilityLabel={`Confirm: ${pa.title}`}
                            >
                              <Text style={styles.actionConfirmText}>{confirmingKey === key ? 'Applying…' : 'Confirm'}</Text>
                            </Pressable>
                          </View>
                        </Animated.View>
                      );
                    })}
                  </React.Fragment>
                ))}

                {!loading && messages.length > 0 && messages[messages.length - 1].role === 'assistant' && messages[messages.length - 1].error && (
                  <Pressable
                    onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); retry(); }}
                    style={[styles.retryBtn, { borderColor: c.accent, backgroundColor: c.accentSoft }]}
                  >
                    <Text style={[styles.retryBtnText, { color: c.accent }]}>Retry</Text>
                  </Pressable>
                )}

                {expState !== null && (
                  <Animated.View
                    entering={FadeInDown.duration(220).springify().damping(18)}
                    style={[styles.expCard, { backgroundColor: c.card, borderColor: c.border }]}
                  >
                    {expState === 'loading' && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                        <ActivityIndicator color={c.accent} />
                        <Text style={[styles.expHint, { color: c.subtext }]}>Extracting experiment…</Text>
                      </View>
                    )}
                    {typeof expState === 'object' && 'notActionable' in expState && (
                      <Text style={[styles.expHint, { color: c.subtext }]}>
                        💡 No clear experiment in this chat yet — keep exploring the topic!
                      </Text>
                    )}
                    {typeof expState === 'object' && 'started' in expState && (
                      <Text style={[styles.expSuccess, { color: c.accent }]}>
                        🧪 Experiment started! Track progress in the Experiments tab.
                      </Text>
                    )}
                    {typeof expState === 'object' && 'hypothesis' in expState && (
                      <>
                        <Text style={[styles.expLabel, { color: c.subtext }]}>EXPERIMENT PROPOSAL</Text>
                        <Text style={[styles.expHypo, { color: c.text }]}>{expState.hypothesis}</Text>
                        <Text style={[styles.expMeta, { color: c.subtext }]}>
                          {`Tracking: ${METRICS[expState.metric]?.label ?? expState.metric}`}
                          {METRICS[expState.metric]?.source ? `  ·  ${METRICS[expState.metric].source}` : ''}
                        </Text>
                        {!!expState.protocol && (
                          <Text style={[styles.expProtocol, { color: c.text }]}>{expState.protocol}</Text>
                        )}
                        <View style={styles.daysRow}>
                          {([14, 21, 28] as const).map((d) => (
                            <Pressable
                              key={d}
                              onPress={() => setExpDays(d)}
                              style={[styles.dayBtn, {
                                borderColor: expDays === d ? c.accent : c.border,
                                backgroundColor: expDays === d ? c.accentSoft : 'transparent',
                              }]}
                            >
                              <Text style={[styles.dayBtnText, { color: expDays === d ? c.accent : c.subtext }]}>{d}d</Text>
                            </Pressable>
                          ))}
                        </View>
                        <Pressable
                          onPress={startExperiment}
                          disabled={expStarting}
                          style={[styles.startBtn, { backgroundColor: c.accent, opacity: expStarting ? 0.6 : 1 }]}
                        >
                          <Text style={styles.startBtnText}>{expStarting ? 'Starting…' : 'Start tracking'}</Text>
                        </Pressable>
                        <Pressable onPress={() => setExpState(null)} style={{ alignItems: 'center', paddingTop: 4 }}>
                          <Text style={[styles.expHint, { color: c.subtext }]}>Dismiss</Text>
                        </Pressable>
                      </>
                    )}
                  </Animated.View>
                )}

                {loading && <ActivityIndicator color={c.accent} style={{ marginTop: spacing.md }} />}
              </ScrollView>

              {/* Save / Experiment / Clear toolbar — only when there's something to act on. */}
              {!empty && (
                <View style={[styles.toolbar, { borderTopColor: c.border }]}>
                  <Pressable onPress={saveChat} hitSlop={6} style={[styles.toolBtn, { backgroundColor: c.accentSoft }]}>
                    <Text style={[styles.toolBtnText, { color: c.accent }]}>＋ Save & start new</Text>
                  </Pressable>
                  {expState === null && messages.some((m) => m.role === 'assistant') && (
                    <Pressable onPress={extractExperiment} hitSlop={6} style={[styles.toolBtnExp, { borderColor: c.border }]}>
                      <Text style={styles.toolExpText}>🧪</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={clearChat} hitSlop={6} style={styles.toolBtnGhost}>
                    <Text style={[styles.toolGhostText, { color: c.subtext }]}>Clear</Text>
                  </Pressable>
                </View>
              )}

              <View style={[styles.inputWrap, { borderTopColor: c.border }]}>
                {/* Context starters — one-tap questions seeded from the screen the
                    user summoned quick-ask from ("FROM THIS SCREEN"). Only shown here
                    once the empty-state already used them as the primary suggestions
                    above and a conversation is under way — otherwise they'd just repeat. */}
                {starters.length > 0 && !empty && (
                  <View style={styles.startersWrap}>
                    <Text style={[styles.startersLabel, { color: c.subtext }]}>FROM THIS SCREEN</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.startersRow}>
                      {starters.map((s) => (
                        <Pressable key={s} onPress={() => submit(s)} style={[styles.starterChip, { borderColor: c.accent, backgroundColor: c.accentSoft }]}>
                          <Text style={[styles.starterText, { color: c.accent }]} numberOfLines={1}>{s}</Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                  </View>
                )}
                <View style={[styles.inputRow, { borderColor: voiceState === 'recording' || voiceState === 'error' ? '#FF6B6B' : c.border, backgroundColor: c.card }]}>
                  <TextInput
                    ref={inputRef}
                    style={[styles.input, { color: c.text }]}
                    placeholder={
                      voiceState === 'recording' ? 'Listening… release to send' :
                      voiceState === 'thinking' ? 'Thinking…' :
                      voiceState === 'error' ? "Didn't catch that — try again" :
                      hadVoiceTurn ? 'Hold the mic to continue…' : 'Ask about your life…'
                    }
                    placeholderTextColor={voiceState === 'recording' || voiceState === 'error' ? '#FF6B6B' : c.subtext}
                    value={question}
                    onChangeText={setQuestion}
                    onSubmitEditing={() => submit(question)}
                    returnKeyType="send"
                    multiline
                    editable={voiceState === 'idle' || voiceState === 'error'}
                    autoCorrect
                    spellCheck
                  />
                  {showLiveEntry && !question.trim() && (
                    <View style={styles.micGroup}>
                      <Pressable
                        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); setTalkOpen(true); }}
                        style={[styles.mic, { backgroundColor: withAlpha('#635BFF', 0.15), borderColor: withAlpha('#635BFF', 0.35) }]}
                        accessibilityRole="button"
                        accessibilityLabel="Talk — start a live voice conversation"
                        accessibilityHint="Opens a full-screen live conversation where NormOS listens and replies out loud in real time."
                      >
                        <Ionicons name="radio-outline" size={17} color="#635BFF" />
                      </Pressable>
                      <Text style={[styles.micCaption, { color: c.subtext }]}>Talk</Text>
                    </View>
                  )}
                  {voiceAvailable && !question.trim() && (
                    <View style={styles.micGroup}>
                      <Pressable
                        onPressIn={voicePressIn}
                        onPressOut={voicePressOut}
                        disabled={voiceState === 'thinking'}
                        style={[styles.mic, {
                          backgroundColor: voiceState === 'recording' ? '#FF6B6B' : withAlpha('#635BFF', 0.15),
                          borderColor: voiceState === 'recording' ? '#FF6B6B' : withAlpha('#635BFF', 0.35),
                        }]}
                        accessibilityRole="button"
                        accessibilityLabel={hadVoiceTurn ? 'Dictate — hold to continue speaking' : 'Dictate — hold to speak'}
                        accessibilityHint="Press and hold to record; release to send your question as text, typed out from what you said."
                      >
                        {voiceState === 'thinking' ? (
                          <ActivityIndicator size="small" color={c.accent} />
                        ) : (
                          <Ionicons
                            name={voiceState === 'recording' ? 'mic' : 'mic-outline'}
                            size={17}
                            color={voiceState === 'recording' ? '#fff' : '#635BFF'}
                          />
                        )}
                      </Pressable>
                      <Text style={[styles.micCaption, { color: c.subtext }]}>Dictate</Text>
                    </View>
                  )}
                  <Pressable onPress={() => submit(question)} style={[styles.send, { backgroundColor: question.trim() ? c.accent : c.border }]} disabled={!question.trim()}>
                    <Text style={styles.sendText}>↑</Text>
                  </Pressable>
                </View>
                <Text style={[styles.disclaimer, { color: c.subtext }]}>AI can make mistakes. Verify important information.</Text>
              </View>
            </>
          )}
        </View>
  );

  const talkOverlay = (
    <TalkOverlay
      visible={talkOpen}
      onClose={() => { setTalkOpen(false); loadHistory(); }}
      onTurnCompleted={loadHistory}
      sessionContext={talkOpen ? currentSessionContext() : undefined}
      onActionExecuted={onVoiceActionExecuted}
    />
  );

  if (embedded) return (<>{chatSheet}{talkOverlay}</>);

  return (
    <>
      {talkOverlay}
      {!hideFab && (
        <Pressable
          // Tap: open the sheet to browse suggestions or type. Long-press:
          // open the sheet AND start listening immediately — one gesture
          // instead of tap-to-open, then press-and-hold the in-sheet mic.
          // RN resolves these as mutually exclusive (onPress only fires if
          // onLongPress didn't already), so both can live on one button.
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setView('chat');
            setStarters(contextStarters ?? []);
            setOpen(true);
          }}
          onLongPress={() => {
            setView('chat');
            setStarters(contextStarters ?? []);
            setOpen(true);
            voicePressIn();
          }}
          onPressIn={() => { fabScale.value = withSpring(0.91, { damping: 12, stiffness: 400 }); }}
          onPressOut={() => {
            fabScale.value = withSpring(1, { damping: 10, stiffness: 300 });
            voicePressOut(); // no-ops if the long-press never started a recording
          }}
          style={[styles.fabWrap, { bottom: bottomInset + 70 }]}
          accessibilityLabel="Ask NormOS — tap to open, hold to talk"
          accessibilityRole="button"
        >
          <Animated.View style={[styles.fab, { backgroundColor: c.accent }, shadow(isDark, 'bar'), fabAnimStyle]}>
            <Ionicons name="mic" size={22} color="#fff" />
          </Animated.View>
        </Pressable>
      )}
      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        {chatSheet}
      </Modal>
    </>
  );
});

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
  fabWrap: {
    position: 'absolute',
    right: spacing.md,
  },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  headerLeftGroup: { flexDirection: 'row', gap: spacing.md },
  headerBtn: { fontSize: 15, fontWeight: '600' },
  threadContent: { padding: spacing.md, paddingBottom: spacing.lg },
  emptyState: { paddingTop: spacing.lg, gap: spacing.sm },
  emptyTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  emptyHint: { fontSize: 14, lineHeight: 21 },
  suggestions: { flexDirection: 'column', gap: spacing.sm, marginTop: spacing.md },
  chip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: 13, borderRadius: radius.md, borderWidth: 1 },
  lastConvRow: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, paddingTop: spacing.md, marginTop: spacing.sm },
  lastConvLabel: { fontSize: 13 },
  lastConvTitle: { fontSize: 13, fontWeight: '600', flex: 1 },
  chipText: { fontSize: 14, fontWeight: '500', flex: 1, lineHeight: 20 },
  chipArrow: { fontSize: 20, fontWeight: '300', marginLeft: spacing.sm },
  chipBadge: {
    fontSize: 9, fontWeight: '800', letterSpacing: 0.6, borderWidth: 1,
    borderRadius: radius.sm, paddingHorizontal: 5, paddingVertical: 2, marginRight: spacing.sm,
  },
  bubble: { borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: 6, marginTop: spacing.sm, maxWidth: '92%' },
  retryBtn: { alignSelf: 'flex-start', marginTop: spacing.xs, marginLeft: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1 },
  retryBtnText: { fontSize: 13, fontWeight: '700' as const },
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
  inputWrap: { borderTopWidth: 1, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  startersWrap: { marginBottom: spacing.sm },
  startersLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.0, marginBottom: 5 },
  startersRow: { gap: spacing.sm, paddingRight: spacing.md },
  starterChip: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    maxWidth: 300,
  },
  starterText: { fontSize: 13, fontWeight: '600' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderWidth: 1,
    borderRadius: 24,
    paddingLeft: spacing.md,
    paddingRight: 6,
    paddingVertical: 6,
    gap: spacing.sm,
  },
  input: { flex: 1, ...typography.body, fontSize: 16, paddingVertical: 6, maxHeight: 120 },
  mic: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#fff', fontWeight: '700', fontSize: 18, lineHeight: 20, marginTop: -1 },
  disclaimer: { fontSize: 11, textAlign: 'center', marginTop: 6, lineHeight: 15 },
  convRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingVertical: spacing.md },
  convBody: { flex: 1, paddingRight: spacing.sm },
  convTitle: { fontSize: 15, fontWeight: '600' },
  convTitleInput: { fontSize: 15, fontWeight: '600', borderBottomWidth: 1, paddingVertical: 2, marginBottom: 2 },
  convMeta: { fontSize: 12, marginTop: 2 },
  rowAction: { paddingHorizontal: spacing.xs, paddingVertical: spacing.xs },
  rowActionIcon: { fontSize: 17 },
  toolBtnExp: { paddingHorizontal: spacing.sm, paddingVertical: 8, borderRadius: radius.md, borderWidth: 1 },
  toolExpText: { fontSize: 17 },
  expCard: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, gap: spacing.sm },
  expLabel: { fontSize: 10, fontWeight: '700' as const, letterSpacing: 0.8 },
  expHypo: { fontSize: 15, fontWeight: '700' as const, lineHeight: 22 },
  expMeta: { fontSize: 13, fontWeight: '500' as const },
  expProtocol: { fontSize: 14, lineHeight: 21 },
  expHint: { fontSize: 13, lineHeight: 20 },
  expSuccess: { fontSize: 14, fontWeight: '700' as const },
  daysRow: { flexDirection: 'row', gap: spacing.sm },
  dayBtn: { paddingHorizontal: spacing.md, paddingVertical: 7, borderRadius: radius.md, borderWidth: 1 },
  dayBtnText: { fontSize: 13, fontWeight: '600' as const },
  startBtn: { paddingVertical: spacing.sm + 2, borderRadius: radius.md, alignItems: 'center' as const, marginTop: 2 },
  startBtnText: { color: '#FFF', fontSize: 15, fontWeight: '700' as const },
  actionCard: {
    alignSelf: 'stretch', marginTop: spacing.xs, marginLeft: spacing.sm, padding: spacing.md,
    borderRadius: radius.md, borderWidth: 1.5, gap: 4,
  },
  actionLabel: { fontSize: 10, fontWeight: '700' as const, letterSpacing: 0.8 },
  actionTitle: { fontSize: 15, fontWeight: '700' as const, lineHeight: 21 },
  actionPreview: { fontSize: 13, lineHeight: 19 },
  actionBtnRow: { flexDirection: 'row', marginTop: 4 },
  actionConfirmBtn: { paddingHorizontal: spacing.lg, paddingVertical: 9, borderRadius: radius.md, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  actionConfirmText: { color: '#FFF', fontSize: 14, fontWeight: '700' as const },
  micGroup: { alignItems: 'center', marginRight: 2 },
  micCaption: { fontSize: 9, fontWeight: '600' as const, marginTop: 2 },
});
