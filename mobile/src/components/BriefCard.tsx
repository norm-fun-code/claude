import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, useColorScheme, TextInput, TouchableOpacity, Pressable, LayoutAnimation, ActivityIndicator, Animated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { getColors, spacing, radius, typography, shadow, glow, accentGradient, withAlpha, FONTS } from '../theme';
import { AnimatedEntry } from './AnimatedEntry';
import type { ChiefBrief } from '../hooks/useBriefing';
import { BRIEFING_CONTEXT_URL, BRIEFING_AUDIO_URL, BRIEFING_ACTION_COMMIT_URL, BRIEFING_ACTION_ALTERNATES_URL, VOICE_TRANSCRIBE_URL, authHeaders, fetchWithTimeout } from '../config';
import { voiceAvailable, ensureMicPermission, startRecording, stopRecording } from '../lib/voice';
import { useBriefAudio } from '../hooks/useBriefAudio';
import { isNarrationBusy, narrationButtonLabel } from '../lib/narrationStatus';
import { resolveChiefBriefState, hasBeenPendingTooLong, describeChiefBriefFailure, describeWaitingForSleepData, type BuildJobState } from '../lib/chiefBriefState';

interface Props {
  brief: ChiefBrief | null | undefined;
  fallback?: string;
  // True when `brief` is carried over from a prior build rather than fresh —
  // shown as a small note so a rebuild that didn't actually refresh this card
  // doesn't look like it silently did nothing (see server chiefBriefStale).
  stale?: boolean;
  // True when NEITHER this build's own attempt NOR a fresh same-day prior
  // was available server-side (see BriefingData.chiefBriefPending) — brief
  // is null, and this shows calm "Finishing…" copy instead of either
  // rendering nothing or leaking fallback/morningFocus text as if it were a
  // completed brief (audit fix, item C).
  pending?: boolean;
  // THE authoritative quality result for `brief` (see BriefingData.
  // chiefBriefQuality) — a defense-in-depth check only: the server already
  // never ships a degraded/failed brief as fresh (item B), but a briefing
  // object hydrated from a stale AsyncStorage cache (written before this
  // fix, or by a future regression) could still carry one. When `stale` is
  // true, `brief` is a carried-forward FRESH prior and this quality result
  // (which always describes THIS build's own attempt, never the carried
  // card) does not apply to it.
  quality?: { status?: string } | null;
  // True when brief's goal-completion claims reference a DIFFERENT week than
  // the live current one (see BriefingData.chiefBriefGoalsStale) — e.g. this
  // brief still says "all goals done" from a week that has since rolled
  // over. Shown as an explicit qualifier so it can never silently look like
  // it's describing THIS week's (possibly still-open) goals (truth-and-
  // evidence contract, audit priority #1).
  goalsStale?: boolean;
  // Fast, scoped retry for just this card (seconds, not the full 60-90s
  // "Rebuild briefing") — wired to POST /api/briefing/chief-brief/rebuild.
  onRefresh?: () => void;
  refreshing?: boolean;
  // Binds "Listen" to the EXACT build on screen (BriefingData.snapshotId) —
  // audit fix, item 4: never lets a stale mobile cache narrate a different
  // build than what's actually displayed.
  snapshotId?: string | null;
  // Today command-center's server-gated risk (see brain/todayCommandCenter.js)
  // — deliberately NOT brief.risk. brief.risk is a REQUIRED field in the
  // chief-brief's structured-output schema, so the model always writes
  // something there even on a day with nothing wrong ("stay the course").
  // This prop is null unless independently-computed evidence (an at-risk
  // forecast, a red capacity day, a truth-contract-gated health anomaly)
  // actually backs a risk — the Today redesign's "no filler Risk section"
  // requirement is enforced server-side, not by trusting the prose here.
  risk?: { title: string; rationale: string; severity?: string } | null;
  // The most recent fetch/refresh attempt (whichever kind) ended in an
  // error (see useBriefing's `error`) — feeds the loading state machine
  // (chiefBriefState.ts) so a failed refresh with good content still on
  // screen offers a retry instead of silently doing nothing, and a failed
  // attempt with NO content ever obtained shows an explicit Retry state
  // instead of an indefinite "Finishing today's brief…".
  error?: boolean;
  // Today's durable build-job state (see useBriefing). The ONLY positive
  // evidence that a build is genuinely running right now — without it, a
  // build that finished hours ago having produced nothing usable was
  // indistinguishable from one still in progress, and pulsed a skeleton
  // forever. null = no job row today (the automatic morning path mints none),
  // which is NOT evidence of a build in flight.
  buildState?: BuildJobState;
  // Safe, non-prose diagnostics used to explain WHY there's no brief.
  buildFailure?: { reasonCodes: string[] | null; persistenceFailed: boolean } | null;
  // Durable (survives app close/reopen) anchor for "how long have we had no
  // brief" — see useBriefing.ts and chiefBriefState.ts's resolvePendingSince.
  pendingSince?: number | null;
  /** False until this session's first fetch has come back — see
   *  chiefBriefState.ts's awaitingFirstFetch for why the card must not
   *  claim a failure before then. */
  awaitingFirstFetch?: boolean;
  // Explicit tri-state from the self-healing GET (routes/briefing.js's
  // selfHealDecision) — 'waiting_for_sleep_data' means the server is
  // DELIBERATELY holding the build for Eight Sleep finalization, not that
  // anything failed (July 30 2026 incident hardening, section 3/6). Never
  // shown as a generic failure when set.
  morningReadinessState?: 'ready' | 'waiting_for_sleep_data' | null;
  morningReadinessReason?: string | null;
  // The authoritative 3-tier publishability contract (backend
  // brain/publishTier.js) — 'grounded_usable' means this IS a real, factually
  // safe, complete brief (never routed through the failure copy), but it was
  // assembled from a deterministic canonical fallback or was otherwise
  // underfilled prose, so it's labeled honestly rather than looking
  // identical to a full premium build (July 30 2026 incident hardening,
  // section 2 — "never labeled premium/fresh").
  publishTier?: 'premium_fresh' | 'grounded_usable' | 'hard_failed' | null;
}

// THE ACTION is the one always-structured beat left on Today (see risk prop
// above for why RISK moved to its own server-gated block, and the Today
// redesign's rationale for dropping THE MOVE from the primary Today flow —
// it was "the most consequential thing that changed," which the new
// sinceMorning/previews sections now cover from canonical, evidence-gated
// sources instead of free LLM prose).
const ACTION_BLOCK = { key: 'action' as const, label: 'THE ACTION', emoji: '⚡️', tint: '#A89CFF' };

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

// A deliberate skeleton for the "we've never had a brief yet this session"
// state (chiefBriefState.ts's 'initial_loading') — a few pulsing placeholder
// bars shaped like the real content (headline, then a shorter action row),
// not an empty card and not indefinite italic text. Plain RN Animated (no
// reanimated/gesture-handler dependency) looping an opacity tween.
function BriefSkeleton() {
  const pulse = React.useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.75, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View style={{ opacity: pulse }} accessibilityLabel="Preparing today's brief" accessibilityRole="progressbar">
      <View style={[styles.skeletonBar, { width: '88%', height: 22 }]} />
      <View style={[styles.skeletonBar, { width: '64%', height: 22, marginBottom: spacing.md }]} />
      <View style={[styles.skeletonBar, { width: '40%', height: 14 }]} />
      <View style={[styles.skeletonBar, { width: '72%', height: 14 }]} />
    </Animated.View>
  );
}

function BriefCard({ brief: rawBrief, fallback, stale, pending, quality, goalsStale, onRefresh, refreshing, snapshotId, risk, error, buildState, buildFailure, pendingSince, awaitingFirstFetch, publishTier, morningReadinessState, morningReadinessReason }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  // The card renders whatever content it's given, verbatim (Chief Brief
  // regression fix, mobile requirement #7) — `rawBrief` is already the
  // server's (or useBriefing's merge function's) fully-resolved DISPLAY
  // content; `quality`/`pending` describe the separate ATTEMPT state and are
  // read below only to choose the loading/failure copy around the content,
  // never to null the content out. Re-deriving a "is this good enough to
  // show" verdict here was the exact bug: `quality` reflects the LATEST
  // attempt, which can be degraded even while `rawBrief` is a perfectly good
  // same-day card carried forward from an earlier attempt.
  const brief = rawBrief;
  // Deterministic loading state machine (On My Radar audit item 8) — the
  // ONE place that decides skeleton vs. last-good-plus-"Updating…" vs.
  // failed-with-retry, instead of `pending` alone driving a single static
  // "Finishing today's brief…" string regardless of whether we already had
  // good content or how long it's been.
  // Last-resort time bound on the skeleton, for when the server gives us NO
  // verdict either way (a cached build predating the quality contract, or an
  // unreachable status endpoint). Without this a skeleton could still run
  // forever in exactly the cases we can't diagnose.
  //
  // `pendingSince` comes from useBriefing's AsyncStorage-backed anchor, NOT a
  // component-local timestamp — this component remounts on every tab switch
  // AND on every app close/reopen (see the bug report this fixed: "it builds
  // the brief, I close the app, reopen it, and nothing is there"), so a
  // mount-local "first render with no brief" timestamp gave every single
  // relaunch a fresh 45 seconds of skeleton and could never actually reach
  // the honest failed/Retry state. See useBriefing.ts and
  // chiefBriefState.ts's resolvePendingSince.
  const [tooLong, setTooLong] = useState(() => hasBeenPendingTooLong(pendingSince ?? null, Date.now()));
  useEffect(() => {
    if (brief || pendingSince == null) { setTooLong(false); return; }
    setTooLong(hasBeenPendingTooLong(pendingSince, Date.now()));
    // Re-evaluate on a timer rather than assuming a re-render will happen —
    // nothing else necessarily changes while we sit in the loading state.
    const id = setInterval(() => setTooLong(hasBeenPendingTooLong(pendingSince, Date.now())), 5_000);
    return () => clearInterval(id);
  }, [brief, pendingSince]);

  const cardState = resolveChiefBriefState({
    brief,
    pending: Boolean(pending),
    refreshing: Boolean(refreshing),
    error: Boolean(error),
    quality: quality?.status as 'fresh' | 'degraded' | 'failed' | undefined,
    buildState,
    pendingTooLong: tooLong,
    awaitingFirstFetch,
  });
  // One short, honest sentence about what went wrong — never raw reason codes
  // and never generated prose (the whole point of the quality gate is that
  // unusable model output doesn't reach the screen).
  const failureReason = describeChiefBriefFailure({
    quality: quality?.status as 'fresh' | 'degraded' | 'failed' | undefined,
    buildState,
    reasonCodes: buildFailure?.reasonCodes ?? (quality as { reasonCodes?: string[] } | null | undefined)?.reasonCodes ?? null,
    persistenceFailed: buildFailure?.persistenceFailed,
  });
  const [note, setNote] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteFailed, setNoteFailed] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  // Progressive disclosure (Today redesign): the open question, affirmation,
  // and free-context box are all valuable but secondary to NOW/ACTION/RISK —
  // collapsed by default so they never compete for the same visual weight as
  // the primary content above the fold.
  const [moreOpen, setMoreOpen] = useState(false);
  const toggleMore = () => {
    Haptics.selectionAsync();
    LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
    setMoreOpen((v) => !v);
  };
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
  // Uses useBriefAudio's shared default timeout/poll-retry policy (see that
  // hook's doc comment): a generous first-attempt window sized above the
  // backend's own bounded TTS deadline, plus one automatic follow-up
  // attempt before ever showing "Unavailable" for a request that was
  // actually still finishing server-side.
  const { state: audioState, toggle: toggleListen } = useBriefAudio(BRIEFING_AUDIO_URL, undefined, snapshotId);

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
          // Server-owned canonical identity for THIS question instance (see
          // useBriefing's ChiefBrief.openQuestionId) — the server loads any
          // structured subject (e.g. exactly which calendar block a
          // meeting-load question described) from its own record by this
          // id, never from anything echoed here. Required for a calendar-
          // load-subject question to durably reclassify the block it was
          // about; a plain question with no subject still answers fine
          // without it.
          questionId: brief?.openQuestionId ?? undefined,
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

  if (!brief && !pending && !fallback) return null;

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
        <View style={styles.kickerLeft}>
          <Text style={styles.kicker}>CHIEF OF STAFF BRIEF</Text>
          {cardState === 'refreshing_with_last_good' && (
            <Text style={styles.updatingBadge} accessibilityLabel="Updating">· Updating…</Text>
          )}
        </View>
        <View style={styles.kickerActions}>
          {onRefresh && (brief || pending) && (
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
              accessibilityState={{ busy: isNarrationBusy(audioState) }}
            >
              <Text style={styles.listenText}>{narrationButtonLabel(audioState)}</Text>
            </Pressable>
          )}
        </View>
      </View>
      {stale && brief && (
        <Text style={styles.staleNote}>Still yesterday's — tap ↻ to retry</Text>
      )}
      {/* Distinct from the `stale` note above (that one is a server-computed
          "this IS a carried-forward prior"; this one is "the last refresh
          WE attempted failed") — never both at once, so at most one amber
          note ever shows. */}
      {!stale && cardState === 'failed_with_last_good' && (
        <Text style={styles.staleNote}>Couldn't refresh — tap ↻ to retry</Text>
      )}
      {/* Honest tier label (July 30 2026 incident hardening, section 2/6):
          a grounded_usable brief is real and safe to read — never routed
          through failure copy — but must never look indistinguishable from
          a full premium build. Suppressed alongside the two amber notes
          above so at most one qualifier note ever shows at once. */}
      {!stale && cardState !== 'failed_with_last_good' && brief && publishTier === 'grounded_usable' && (
        <Text style={styles.staleNote}>Simplified brief — today's numbers, briefly stated</Text>
      )}
      {/* The "references an earlier week's goals" warning is gone —
          NormOS now detects and repairs this itself (one automatic scoped
          chief-brief rebuild server-side, see routes/briefing.js's cache-hit
          serve path) rather than knowingly serving the stale claim and
          asking the user to fix it. `goalsStale` is still threaded through
          (server-side defense-in-depth / an older cached payload) but no
          longer rendered as a user-facing ask. */}

      {brief ? (
        <>
          <AnimatedEntry delay={60} distance={10}>
            <HighlightedSynthesis text={brief.synthesis} />
          </AnimatedEntry>
          <View style={styles.separator} />
          {/* THE ACTION — the ONE primary CTA (Today redesign: exactly one
              action, not several competing beats). RISK below is entirely
              separate: server-gated (see the `risk` prop's doc comment), so
              it renders only when real evidence backs it, never from
              brief.risk's always-filled prose. */}
          <AnimatedEntry delay={130} distance={8}>
            <BeatRow label={ACTION_BLOCK.label} emoji={ACTION_BLOCK.emoji} tint={ACTION_BLOCK.tint} text={brief.action} />
            {/* One-tap commit on THE ACTION: turns the morning's highest-
                leverage move into a real commitment (due tonight, reminded,
                auto-verified from metrics where possible) instead of prose
                the user has to transcribe into their own system. */}
            {brief.action ? (
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
            {brief.action && actionCommit !== 'done' ? (
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
          {risk ? (
            <AnimatedEntry delay={185} distance={8}>
              <BeatRow label="THE RISK" emoji="⚠️" tint="#FFC44D" text={risk.rationale} />
            </AnimatedEntry>
          ) : null}
        </>
      ) : cardState === 'failed_empty' ? (
        <AnimatedEntry delay={60} distance={10}>
          {/* Never an indefinite "Finishing…" — say what's actually
              happening and offer a deliberate, user-initiated retry (never
              auto-retried by a timer or by re-renders/polling).
              waiting_for_sleep_data is NOT a failure — the server is
              deliberately holding the build for Eight Sleep finalization
              (July 30 2026 incident hardening) — so it gets its own honest
              header/copy instead of "Couldn't put together today's brief."
              A manual tap still bypasses the sleep-readiness wait. */}
          {morningReadinessState === 'waiting_for_sleep_data' ? (
            <>
              <Text style={styles.failedEmptyText}>Finishing last night's sleep data.</Text>
              <Text style={styles.failedEmptyReason}>{describeWaitingForSleepData(morningReadinessReason)}</Text>
            </>
          ) : (
            <>
              <Text style={styles.failedEmptyText}>Couldn't put together today's brief.</Text>
              <Text style={styles.failedEmptyReason}>{failureReason}</Text>
            </>
          )}
          {onRefresh && (
            <Pressable
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onRefresh(); }}
              disabled={refreshing}
              style={styles.retryBtn}
              accessibilityRole="button"
              accessibilityLabel={morningReadinessState === 'waiting_for_sleep_data' ? 'Build now' : 'Retry'}
            >
              {refreshing ? <ActivityIndicator size="small" color="#A89CFF" /> : (
                <Text style={styles.retryBtnText}>{morningReadinessState === 'waiting_for_sleep_data' ? 'Build now' : 'Retry'}</Text>
              )}
            </Pressable>
          )}
        </AnimatedEntry>
      ) : (
        <AnimatedEntry delay={60} distance={10}>
          {/* No fresh chiefBrief and no fresh same-day prior to carry
              forward (or a defensive client-side reject of degraded/failed
              content) — a deliberate skeleton (chiefBriefState.ts's
              'initial_loading'), never the raw fallback/morningFocus text
              mistaken for a completed brief (audit fix, item C), and never
              an empty card. */}
          <BriefSkeleton />
        </AnimatedEntry>
      )}

      {/* Progressive disclosure (Today redesign): the open question,
          affirmation, and free-context box are all real, useful features —
          kept in full, just no longer competing for the same above-the-fold
          weight as NOW/ACTION/RISK. A pending open question keeps a small
          dot on the collapsed toggle so it's never silently missed. */}
      <Pressable onPress={toggleMore} style={styles.moreToggle} hitSlop={8}>
        <Text style={styles.moreToggleText}>{moreOpen ? 'Less' : 'More from your Chief of Staff'}</Text>
        {!moreOpen && brief && openQ ? <View style={styles.moreDot} /> : null}
        <Text style={[styles.beatChevron, moreOpen && styles.beatChevronOpen]}>›</Text>
      </Pressable>
      {moreOpen && (
      <>
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
      </>
      )}
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
  moreToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.sm,
    paddingVertical: spacing.xs,
    minHeight: 44, // 44pt touch target
  },
  moreToggleText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: '600',
  },
  moreDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#A89CFF',
  },
  qText: { ...typography.body, color: '#fff', fontSize: 15, lineHeight: 22, fontWeight: '600' },
  qThanks: { ...typography.caption, color: '#A89CFF', fontSize: 13, marginTop: spacing.sm, fontStyle: 'italic' },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  kickerLeft: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    flexShrink: 1,
  },
  kicker: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    color: '#A89CFF',
  },
  updatingBadge: {
    fontSize: 10,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.45)',
    fontStyle: 'italic',
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
  pendingText: {
    fontFamily: FONTS.display,
    fontSize: 17,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.6)',
    fontStyle: 'italic',
    lineHeight: 24,
    marginBottom: spacing.md,
  },
  skeletonBar: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: radius.sm,
    marginBottom: spacing.sm,
  },
  failedEmptyText: {
    fontFamily: FONTS.text,
    fontSize: 15,
    lineHeight: 21,
    color: 'rgba(255,255,255,0.65)',
    marginBottom: spacing.xs,
  },
  // The one-line "why" under the headline — quieter than the headline, so the
  // card explains itself without turning a failure into a wall of text.
  failedEmptyReason: {
    fontFamily: FONTS.text,
    fontSize: 13,
    lineHeight: 19,
    color: 'rgba(255,255,255,0.45)',
    marginBottom: spacing.md,
  },
  retryBtn: {
    alignSelf: 'flex-start',
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(168,156,255,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  retryBtnText: {
    color: '#A89CFF',
    fontSize: 14,
    fontWeight: '700',
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
