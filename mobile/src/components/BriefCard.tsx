import React, { useState } from 'react';
import { View, Text, StyleSheet, useColorScheme, TextInput, TouchableOpacity, Pressable, LayoutAnimation, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { getColors, spacing, radius, typography, shadow, glow, accentGradient, withAlpha, FONTS } from '../theme';
import { AnimatedEntry } from './AnimatedEntry';
import type { ChiefBrief } from '../hooks/useBriefing';
import { BRIEFING_CONTEXT_URL, BRIEFING_AUDIO_URL, BRIEFING_ACTION_COMMIT_URL, BRIEFING_ACTION_ALTERNATES_URL, VOICE_TRANSCRIBE_URL, authHeaders, fetchWithTimeout } from '../config';
import { voiceAvailable, ensureMicPermission, startRecording, stopRecording } from '../lib/voice';
import { useBriefAudio } from '../hooks/useBriefAudio';

interface Props {
  brief: ChiefBrief | null | undefined;
  fallback?: string;
  // True when `brief` is carried over from a prior build rather than fresh —
  // shown as a small note so a rebuild that didn't actually refresh this card
  // doesn't look like it silently did nothing (see server chiefBriefStale).
  stale?: boolean;
  // Fast, scoped retry for just this card (seconds, not the full 60-90s
  // "Rebuild briefing") — wired to POST /api/briefing/chief-brief/rebuild.
  onRefresh?: () => void;
  refreshing?: boolean;
}

// Each block gets a mini emoji tile (same elevated-tile language as
// SectionHeader) and its own tint so the three beats read as distinct at a
// glance even before any text is parsed.
const BLOCKS: { key: 'action' | 'risk' | 'move'; label: string; emoji: string; tint: string }[] = [
  { key: 'action', label: 'THE ACTION', emoji: '⚡️', tint: '#A89CFF' },
  { key: 'risk', label: 'THE RISK', emoji: '⚠️', tint: '#FFC44D' },
  { key: 'move', label: 'THE MOVE', emoji: '📈', tint: '#5AE89A' },
];

// Editorial number highlighting: the synthesis is a headline, and the numbers
// are its payload — set them in the accent so the eye catches "64", "29%",
// "$7,497" before reading a word. Word-level match (not a global regex) so
// "30-minute" stays plain while "10,314", "4.6/5", "38.4ms" light up.
// The numeric core must END in a digit (no trailing-comma/period absorption:
// "at 64." highlights "64", not "64.") and allows one decimal part, so
// version-ish strings like "1.1.0" stay plain.
const NUM_CORE = /^([("']*)(\$?\d(?:[\d,]*\d)?(?:\.\d+)?(?:%|ms|bpm|h|k|x)?(?:\/\d+)?)([)"',.;:!?]*)$/;

// Recovery-band words render in their actual color — "green" IS green — and a
// number shortly after one ("green at 64") matches the band color instead of
// the generic accent, so the headline's state + score read as one signal.
const BAND_WORD: Record<string, string> = {
  green: '#5AE89A',
  yellow: '#FFC44D',
  red: '#FF8478',
};
const BAND_RE = /^[("']*(green|yellow|red)[)"',.;:!?]*$/i;

function HighlightedSynthesis({ text }: { text: string }) {
  const words = text.split(' ');
  // How many upcoming number tokens inherit the band color ("green at 64").
  let bandColor: string | null = null;
  let bandReach = 0;
  return (
    <Text style={styles.synthesis}>
      {words.map((w, i) => {
        const space = i < words.length - 1 ? ' ' : '';
        const band = w.match(BAND_RE);
        if (band) {
          const color = BAND_WORD[band[1].toLowerCase()];
          bandColor = color;
          bandReach = 3;
          const core = band[1];
          const pre = w.slice(0, w.indexOf(core));
          const post = w.slice(pre.length + core.length);
          return (
            <React.Fragment key={i}>
              {pre}
              <Text style={{ color, fontWeight: '800' }}>{core}</Text>
              {post + space}
            </React.Fragment>
          );
        }
        const m = w.match(NUM_CORE);
        if (bandReach > 0) bandReach -= 1;
        if (!m) return w + space;
        const numColor = bandReach > 0 && bandColor ? bandColor : undefined;
        if (bandReach > 0) { bandReach = 0; bandColor = null; } // one number per band mention
        return (
          <React.Fragment key={i}>
            {m[1]}
            <Text style={[styles.synthesisNum, numColor ? { color: numColor } : null]}>{m[2]}</Text>
            {m[3] + space}
          </React.Fragment>
        );
      })}
    </Text>
  );
}

// One compact, expandable beat row. Collapsed it's a two-line scannable
// summary; tapping unfolds the full text in place. LayoutAnimation keeps the
// unfold soft instead of a jump cut.
function BeatRow({ label, emoji, tint, text }: { label: string; emoji: string; tint: string; text: string }) {
  const [open, setOpen] = useState(false);

  const toggle = () => {
    Haptics.selectionAsync();
    LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
    setOpen((v) => !v);
  };

  return (
    <Pressable onPress={toggle} style={styles.beat}>
      <View style={[styles.beatTile, { backgroundColor: withAlpha(tint, 0.16), borderColor: withAlpha(tint, 0.28) }]}>
        <Text style={styles.beatEmoji}>{emoji}</Text>
      </View>
      <View style={styles.beatBody}>
        <View style={styles.beatHead}>
          <Text style={[styles.blockLabel, { color: tint, marginBottom: 0 }]}>{label}</Text>
          <Text style={[styles.beatChevron, open && styles.beatChevronOpen]}>›</Text>
        </View>
        <Text style={styles.blockText} numberOfLines={open ? undefined : 2}>
          {text}
        </Text>
      </View>
    </Pressable>
  );
}

// Questions answered THIS app session, remembered at module level. The tabs
// share one ScrollView, so switching tabs unmounts this card and wipes its
// 'saved ✓' state — while the App-level briefing data (which still carries the
// question) survives. On remount the already-answered question would pop back
// up before the next refetch lands.
//
// This is an OPTIMISTIC UI AID ONLY — not the source of truth. The server's
// answered_open_questions ledger (see backend's
// intelligence/open-question-policy.js) is what actually prevents a repeat,
// across every generation path (full build, scoped rebuild, a fresh install,
// a second device, or this Set simply being empty after an app restart). Do
// not rely on this Set for correctness; it only smooths the current mount's
// UI until the next server-truth refetch.
const answeredQuestions = new Set<string>();

function BriefCard({ brief, fallback, stale, onRefresh, refreshing }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [note, setNote] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteFailed, setNoteFailed] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  // The chief's one open question (when present) — answered inline; the answer
  // becomes context for the next brief so it learns from the correction.
  // A question answered earlier this session stays retired across REMOUNTS —
  // but the suppression is decided once, at mount, so the mount where the user
  // just answered still shows its 'saved ✓' confirmation instead of the whole
  // box vanishing mid-interaction.
  const rawQ = brief?.openQuestion?.trim() || '';
  const [suppressAnswered] = useState(() => rawQ !== '' && answeredQuestions.has(rawQ));
  const openQ = suppressAnswered ? '' : rawQ;
  // Data-grounded affirmation for today (a real streak/win/trend) — empty on
  // a briefing cached from before this field existed, in which case the
  // block just doesn't render rather than showing stale/missing text.
  const affirmation = brief?.affirmation?.trim() || '';

  // One-tap commit state for THE ACTION. 'error' stays tappable as a retry;
  // 'done' is terminal for this mount (the commitment now lives on the Today
  // card's commitments list).
  const [actionCommit, setActionCommit] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  async function commitText(text: string) {
    if (!text.trim() || actionCommit === 'saving' || actionCommit === 'done') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActionCommit('saving');
    try {
      const res = await fetchWithTimeout(BRIEFING_ACTION_COMMIT_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text: text.trim() }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      setActionCommit('done');
      setAltPicker('closed');
    } catch {
      setActionCommit('error'); // tap again to retry
    }
  }
  const commitAction = () => brief?.action && commitText(brief.action);

  // "Commit to something else" — the leverage engine ranks up to 3 candidate
  // moves but only the top one becomes THE ACTION; this surfaces the other
  // ranked ones (or a freeform box if none are available) so today's suggested
  // action isn't the only option on the table.
  const [altPicker, setAltPicker] = useState<'closed' | 'loading' | 'open' | 'error'>('closed');
  const [alternates, setAlternates] = useState<{ id: number; title: string; detail: string | null }[]>([]);
  const [altText, setAltText] = useState('');
  async function openAltPicker() {
    if (altPicker === 'loading' || actionCommit === 'saving' || actionCommit === 'done') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setAltPicker('loading');
    try {
      const res = await fetchWithTimeout(BRIEFING_ACTION_ALTERNATES_URL, { headers: authHeaders() });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const json = await res.json();
      setAlternates(Array.isArray(json.alternates) ? json.alternates : []);
      setAltPicker('open');
    } catch {
      setAlternates([]);
      setAltPicker('open'); // still let them type a freeform one
    }
  }
  const [qAnswer, setQAnswer] = useState('');
  const [qState, setQState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // Voice input for the one question — hold, speak, release → transcribed and
  // sent, same hold-to-talk pattern as the Ask overlay's push-to-talk.
  const [qVoice, setQVoice] = useState<'idle' | 'recording' | 'thinking'>('idle');
  // Spoken narration — streamed from the server's pre-warmed neural TTS.
  // 60s (not 30s): the backend's TTS call can itself take up to ~45s per
  // model attempt (see voice.js's GEMINI_TTS_TIMEOUT_MS) before falling back
  // to the next candidate model — a shorter client timeout used to abort and
  // show "Unavailable" WHILE a slow-but-recoverable backend request was
  // still running and about to succeed.
  const { state: audioState, toggle: toggleListen } = useBriefAudio(BRIEFING_AUDIO_URL, 60000);

  async function answerQuestion(overrideText?: string) {
    const trimmed = (overrideText ?? qAnswer).trim();
    if (!trimmed || qState === 'saving') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setQState('saving');
    try {
      const res = await fetchWithTimeout(BRIEFING_CONTEXT_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          question: openQ,
          answer: trimmed,
          signalKey: 'brief_open_question',
          // Server-computed identity for this exact question (see
          // useBriefing's ChiefBrief.openQuestionFingerprint) — echoed back
          // so the durable ledger record carries it. The server still keys
          // suppression off the question TEXT itself, so an older client
          // that omits this (or a briefing cached before the field existed)
          // keeps working unchanged.
          fingerprint: brief?.openQuestionFingerprint ?? undefined,
        }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      // Retire the question for the rest of this app session — the card
      // unmounts on tab switches and must not re-ask on remount. Keep qState
      // 'saved' too so the current mount still shows the confirmation beat.
      answeredQuestions.add(openQ);
      setQState('saved');
    } catch {
      // Was silently resetting to 'idle' here — identical to "never submitted",
      // so a network blip or server hiccup left no way to tell whether a
      // spoken/typed answer registered. Now surfaces a visible error + haptic
      // instead, and keeps the answer text so the user can just retry.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      setQState('error');
    }
  }

  async function qVoicePressIn() {
    if (qVoice !== 'idle') return;
    if (!(await ensureMicPermission())) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await startRecording();
      setQVoice('recording');
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      setQState('error');
      setQVoice('idle');
    }
  }

  async function qVoicePressOut() {
    if (qVoice !== 'recording') return;
    setQVoice('thinking');
    try {
      const rec = await stopRecording();
      if (!rec) {
        // stopRecording() returns null on a failed/too-short capture (no audio
        // file produced, or under ~1/8s of audio) — this was the actual gap:
        // the transcribe-call catch below already surfaces an error, but THIS
        // early-return was still silent, exactly matching "said Listening…,
        // released, nothing happened" with no indication anything went wrong.
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        setQState('error');
        return;
      }
      Haptics.selectionAsync();
      const res = await fetchWithTimeout(VOICE_TRANSCRIBE_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ audio: rec.base64, mime: rec.mime }),
      }, 30000);
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data = await res.json();
      const text = String(data?.text || '').trim();
      if (text) {
        setQAnswer(text);
        await answerQuestion(text);
      } else {
        // Transcription came back empty (mic caught nothing usable) — the Ask
        // overlay's push-to-talk silently drops this case, but here the user is
        // answering a rare, precious one-time question and needs to know their
        // "yes" or "scaling back" didn't actually go anywhere.
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        setQState('error');
      }
    } catch {
      // Same reasoning as above: don't silently drop a failed transcription on
      // THIS flow, even though the Ask overlay's push-to-talk does.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      setQState('error');
    } finally {
      setQVoice('idle');
    }
  }

  async function saveNote() {
    const trimmed = note.trim();
    if (!trimmed || noteSaving) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setNoteSaving(true);
    setNoteFailed(false);
    try {
      const res = await fetchWithTimeout(BRIEFING_CONTEXT_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ answer: trimmed, signalKey: 'manual_context' }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      setNote('');
      setNoteSaved(true);
      setTimeout(() => setNoteSaved(false), 3000);
    } catch {
      setNoteFailed(true);
    } finally {
      setNoteSaving(false);
    }
  }

  if (!brief && !fallback) return null;

  return (
    <View style={[styles.card, glow('#5A52F0', 0.22, 26)]}>
      <LinearGradient
        colors={['#2A2A36', '#1A1A1F']}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.7, y: 1 }}
        style={styles.gradient}
      />
      {/* signature accent bar */}
      <LinearGradient colors={accentGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.accentBar} />
      <View style={styles.kickerRow}>
        <Text style={styles.kicker}>CHIEF OF STAFF BRIEF</Text>
        <View style={styles.kickerActions}>
          {onRefresh && brief && (
            <Pressable
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onRefresh(); }}
              disabled={refreshing}
              hitSlop={8}
              style={styles.refreshBtn}
            >
              {refreshing ? (
                <ActivityIndicator size="small" color="#A89CFF" />
              ) : (
                <Text style={styles.refreshText}>↻</Text>
              )}
            </Pressable>
          )}
          {voiceAvailable && brief && (
            <Pressable
              onPress={toggleListen}
              hitSlop={8}
              style={styles.listenBtn}
              accessibilityRole="button"
              accessibilityLabel={audioState === 'playing' ? 'Stop narration' : 'Listen to this morning\'s brief'}
              accessibilityState={{ busy: audioState === 'loading', disabled: audioState === 'loading' }}
            >
              {audioState === 'loading' ? (
                <ActivityIndicator size="small" color="#A89CFF" />
              ) : (
                <Text style={styles.listenText}>
                  {audioState === 'playing' ? '◼ Stop' : audioState === 'error' ? 'Unavailable' : '▶ Listen'}
                </Text>
              )}
            </Pressable>
          )}
        </View>
      </View>
      {stale && brief && (
        <Text style={styles.staleNote}>Still yesterday's — tap ↻ to retry</Text>
      )}

      {brief ? (
        <>
          <AnimatedEntry delay={60} distance={10}>
            <HighlightedSynthesis text={brief.synthesis} />
          </AnimatedEntry>
          <View style={styles.separator} />
          {BLOCKS.map(({ key, label, emoji, tint }, idx) => (
            <AnimatedEntry key={key} delay={130 + idx * 55} distance={8}>
              <BeatRow label={label} emoji={emoji} tint={tint} text={brief[key]} />
              {/* One-tap commit on THE ACTION: turns the morning's highest-
                  leverage move into a real commitment (due tonight, reminded,
                  auto-verified from metrics where possible) instead of prose
                  the user has to transcribe into their own system. */}
              {key === 'action' && brief.action ? (
                <TouchableOpacity
                  onPress={commitAction}
                  disabled={actionCommit !== 'idle'}
                  style={styles.commitBtn}
                  hitSlop={6}
                >
                  <Text style={[styles.commitBtnText, actionCommit === 'done' && { color: '#5AE89A' }]}>
                    {actionCommit === 'done'
                      ? '✓ Committed — on your list for today'
                      : actionCommit === 'saving'
                        ? 'Committing…'
                        : actionCommit === 'error'
                          ? "Didn't go through — tap to retry"
                          : '→ Commit to this'}
                  </Text>
                </TouchableOpacity>
              ) : null}
              {key === 'action' && brief.action && actionCommit !== 'done' ? (
                altPicker === 'closed' || altPicker === 'loading' ? (
                  <TouchableOpacity onPress={openAltPicker} disabled={altPicker === 'loading'} hitSlop={6} style={styles.altLink}>
                    <Text style={styles.altLinkText}>
                      {altPicker === 'loading' ? 'Loading other options…' : 'Commit to something else'}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <View style={styles.altPicker}>
                    {alternates.map((a) => (
                      <TouchableOpacity key={a.id} onPress={() => commitText(a.title)} disabled={actionCommit === 'saving'} style={styles.altRow}>
                        <Text style={styles.altRowText}>{a.title}</Text>
                        {a.detail ? <Text style={styles.altRowDetail}>{a.detail}</Text> : null}
                      </TouchableOpacity>
                    ))}
                    <View style={styles.altFreeformRow}>
                      <TextInput
                        style={styles.altFreeformInput}
                        placeholder="Or write your own…"
                        placeholderTextColor={c.subtext}
                        value={altText}
                        onChangeText={setAltText}
                        onSubmitEditing={() => commitText(altText)}
                        returnKeyType="done"
                        autoCorrect
                        spellCheck
                      />
                      <TouchableOpacity onPress={() => commitText(altText)} disabled={!altText.trim() || actionCommit === 'saving'} hitSlop={6}>
                        <Text style={[styles.altLinkText, !altText.trim() && { opacity: 0.4 }]}>Commit</Text>
                      </TouchableOpacity>
                    </View>
                    <TouchableOpacity onPress={() => setAltPicker('closed')} hitSlop={6}>
                      <Text style={styles.altCancelText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                )
              ) : null}
            </AnimatedEntry>
          ))}
        </>
      ) : (
        <AnimatedEntry delay={60} distance={10}>
          {/* morningFocus is the lead text whenever the chief brief hasn't
              generated — it gets the same headline number treatment. */}
          <HighlightedSynthesis text={fallback ?? ''} />
        </AnimatedEntry>
      )}

      {/* The chief's one open question — only when the brief genuinely has one.
          Answering it teaches the next brief and can correct today's read. */}
      {brief && openQ ? (
        <View style={styles.qWrap}>
          <View style={styles.beat}>
            <View style={[styles.beatTile, { backgroundColor: withAlpha('#A89CFF', 0.18), borderColor: withAlpha('#A89CFF', 0.32) }]}>
              <Text style={styles.beatEmoji}>💬</Text>
            </View>
            <View style={styles.beatBody}>
              <Text style={[styles.blockLabel, { color: '#A89CFF', marginBottom: 4 }]}>ONE QUESTION</Text>
              <Text style={styles.qText}>{openQ}</Text>
            </View>
          </View>
          {qState === 'saved' ? (
            <Text style={styles.qThanks}>Got it — I'll factor that into tomorrow's brief.</Text>
          ) : (
            <View style={styles.contextRow}>
              <TextInput
                style={[styles.contextInput, qVoice === 'recording' && styles.contextInputRecording]}
                placeholder={qVoice === 'recording' ? 'Listening… release to send' : qVoice === 'thinking' ? 'Thinking…' : 'Your answer…'}
                placeholderTextColor={qVoice === 'recording' ? '#FF6B6B' : 'rgba(255,255,255,0.4)'}
                value={qAnswer}
                onChangeText={setQAnswer}
                returnKeyType="send"
                onSubmitEditing={() => answerQuestion()}
                editable={qVoice === 'idle'}
                multiline={false}
                autoCorrect
                spellCheck
              />
              {voiceAvailable && (
                <Pressable
                  onPressIn={qVoicePressIn}
                  onPressOut={qVoicePressOut}
                  disabled={qVoice === 'thinking'}
                  style={[
                    styles.qMicBtn,
                    qVoice === 'recording' && { backgroundColor: '#FF6B6B', borderColor: '#FF6B6B' },
                  ]}
                  accessibilityLabel="Hold to answer by voice"
                >
                  {qVoice === 'thinking' ? (
                    <ActivityIndicator size="small" color="#A89CFF" />
                  ) : (
                    <Ionicons
                      name={qVoice === 'recording' ? 'mic' : 'mic-outline'}
                      size={15}
                      color={qVoice === 'recording' ? '#fff' : '#A89CFF'}
                    />
                  )}
                </Pressable>
              )}
              <TouchableOpacity
                onPress={() => answerQuestion()}
                disabled={!qAnswer.trim() || qState === 'saving' || qVoice !== 'idle'}
                style={[styles.contextBtn, { opacity: qAnswer.trim() && qState !== 'saving' && qVoice === 'idle' ? 1 : 0.4 }]}
              >
                <Text style={styles.contextBtnText}>→</Text>
              </TouchableOpacity>
            </View>
          )}
          {qState === 'error' && (
            <Text style={styles.contextFailed}>Didn't go through — try again.</Text>
          )}
        </View>
      ) : null}

      {affirmation ? (
        <>
          <View style={styles.separator} />
          <Text style={styles.blockLabel}>AFFIRMATION</Text>
          <View style={styles.affRow}>
            <Text style={styles.affBullet}>✦</Text>
            <Text style={styles.affText}>{affirmation}</Text>
          </View>
        </>
      ) : null}

      <View style={styles.separator} />
      <Text style={styles.blockLabel}>ADD CONTEXT FOR NEXT BRIEF</Text>
      <View style={styles.contextRow}>
        <TextInput
          style={styles.contextInput}
          placeholder="Anything the Chief of Staff should know…"
          placeholderTextColor="rgba(255,255,255,0.4)"
          value={note}
          onChangeText={setNote}
          returnKeyType="send"
          onSubmitEditing={saveNote}
          multiline={false}
          autoCorrect
          spellCheck
        />
        <TouchableOpacity
          onPress={saveNote}
          disabled={!note.trim() || noteSaving}
          style={[styles.contextBtn, { opacity: note.trim() && !noteSaving ? 1 : 0.4 }]}
        >
          <Text style={styles.contextBtnText}>{noteSaved ? '✓' : '→'}</Text>
        </TouchableOpacity>
      </View>
      {noteFailed && <Text style={styles.contextFailed}>Couldn't save — try again.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
    overflow: 'hidden',
    backgroundColor: '#1C1C1E',
  },
  gradient: {
    ...StyleSheet.absoluteFillObject,
  },
  accentBar: {
    width: 44,
    height: 3,
    borderRadius: 2,
    marginBottom: spacing.sm,
  },
  qWrap: {
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.12)',
  },
  qText: { ...typography.body, color: '#fff', fontSize: 15, lineHeight: 22, fontWeight: '600' },
  qThanks: { ...typography.caption, color: '#A89CFF', fontSize: 13, marginTop: spacing.sm, fontStyle: 'italic' },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  kicker: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    color: '#A89CFF',
  },
  staleNote: {
    fontSize: 10,
    fontWeight: '600',
    color: '#FFC44D',
    marginBottom: spacing.sm,
  },
  kickerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  refreshBtn: {
    borderWidth: 1,
    borderColor: 'rgba(168,156,255,0.4)',
    borderRadius: radius.pill,
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshText: { color: '#A89CFF', fontSize: 14, fontWeight: '700' },
  listenBtn: {
    borderWidth: 1,
    borderColor: 'rgba(168,156,255,0.4)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 3,
    minWidth: 64,
    alignItems: 'center',
  },
  listenText: { color: '#A89CFF', fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  // The synthesis IS the headline — editorial display type, not body copy.
  synthesis: {
    fontFamily: FONTS.display,
    fontSize: 21,
    fontWeight: '700',
    color: '#fff',
    lineHeight: 30,
    letterSpacing: -0.4,
    marginBottom: spacing.md,
  },
  synthesisNum: {
    color: '#A89CFF',
  },
  separator: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
    marginBottom: spacing.md,
  },
  beat: {
    flexDirection: 'row',
    gap: spacing.sm + 2,
    marginBottom: spacing.md,
    alignItems: 'flex-start',
  },
  beatTile: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  beatEmoji: {
    fontSize: 12,
    lineHeight: 16,
  },
  beatBody: {
    flex: 1,
  },
  beatHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  beatChevron: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 15,
    fontWeight: '700',
    transform: [{ rotate: '90deg' }],
  },
  beatChevronOpen: {
    transform: [{ rotate: '-90deg' }],
  },
  blockLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.0,
    color: '#A89CFF',
    marginBottom: 4,
  },
  blockText: {
    ...typography.body,
    color: '#fff',
    fontSize: 14,
    lineHeight: 22,
  },
  affRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: 5,
  },
  commitBtn: {
    // Indented to align under the beat's text column (tile width + gap).
    marginLeft: 44,
    marginTop: 2,
    marginBottom: 4,
  },
  commitBtnText: {
    color: '#A89CFF',
    fontSize: 13,
    fontWeight: '600',
  },
  altLink: {
    marginLeft: 44,
    marginTop: 2,
    marginBottom: 4,
  },
  altLinkText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: '500',
  },
  altPicker: {
    marginLeft: 44,
    marginTop: 4,
    marginBottom: 6,
    gap: 6,
  },
  altRow: {
    paddingVertical: 6,
  },
  altRowText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  altRowDetail: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    marginTop: 1,
  },
  altFreeformRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 4,
  },
  altFreeformInput: {
    flex: 1,
    color: '#fff',
    fontSize: 13,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.2)',
    paddingVertical: 4,
  },
  altCancelText: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 12,
    marginTop: 6,
  },
  affBullet: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    lineHeight: 22,
  },
  affText: {
    ...typography.body,
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    lineHeight: 22,
    fontStyle: 'italic',
    flex: 1,
  },
  contextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  contextInput: {
    flex: 1,
    ...typography.body,
    fontSize: 13,
    color: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  contextInputRecording: {
    borderColor: '#FF6B6B',
  },
  qMicBtn: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: withAlpha('#A89CFF', 0.35),
    backgroundColor: withAlpha('#A89CFF', 0.15),
    alignItems: 'center',
    justifyContent: 'center',
  },
  contextBtn: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  contextBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  contextFailed: {
    ...typography.caption,
    color: 'rgba(255,255,255,0.6)',
    marginTop: spacing.xs,
    fontSize: 12,
  },
});

const BriefCardMemo = React.memo(BriefCard);
export { BriefCardMemo as BriefCard };
