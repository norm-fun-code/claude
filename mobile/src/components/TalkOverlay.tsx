import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Modal, ScrollView, TextInput, useColorScheme, Keyboard, Platform } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSpring,
  Easing,
  FadeInDown,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography, withAlpha, glow } from '../theme';
import { RealtimeVoiceSession, RealtimeState, realtimeVoiceAvailable } from '../lib/realtimeVoice';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called whenever a turn completes, so a caller showing its own copy of
   *  the shared thread (e.g. AskOverlay's typed view) can resync. */
  onTurnCompleted?: () => void;
}

interface TranscriptLine { role: 'user' | 'assistant'; text: string; }

const STATE_COPY: Record<RealtimeState, string> = {
  idle: '',
  connecting: 'Connecting…',
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: 'Speaking — tap to interrupt',
  executing: 'One sec…',
  error: '',
};

// Every reason code the backend (routes/realtime.js) or the WebRTC session
// itself (lib/realtimeVoice.ts) can report, mapped to a specific, useful
// message — replaces the old behavior of collapsing every failure into one
// generic "Live voice isn't available right now" with no way to tell what
// actually went wrong or to retry. Pure lookup, easy to eyeball/extend.
const ERROR_MESSAGES: Record<string, string> = {
  realtime_disabled: 'Live voice is temporarily turned off.',
  openai_not_configured: "Live voice isn't set up on the server yet.",
  openai_auth_failed: "Live voice couldn't authenticate with its voice provider.",
  openai_access_denied: 'Live voice access is restricted for this account.',
  invalid_realtime_model: "Live voice's configuration needs attention.",
  session_mint_failed: "Couldn't start live voice — try again in a moment.",
  webrtc_handshake_failed: "Couldn't connect the voice link — try again.",
  network_failure: 'No connection — check your network and try again.',
};
const DEFAULT_ERROR_MESSAGE = "Couldn't start live voice — try again in a moment.";

function messageForErrorCode(code?: string): string {
  return (code && ERROR_MESSAGES[code]) || DEFAULT_ERROR_MESSAGE;
}

// Calm, single-orb presence indicator — deliberately not a "busy call
// screen." One breathing circle whose speed/scale reads the state at a
// glance: slow & soft when listening, quicker when thinking/executing,
// fuller when speaking.
function PresenceOrb({ state, accent }: { state: RealtimeState; accent: string }) {
  const scale = useSharedValue(1);

  useEffect(() => {
    if (state === 'listening') {
      scale.value = withRepeat(withTiming(1.08, { duration: 1400, easing: Easing.inOut(Easing.sin) }), -1, true);
    } else if (state === 'thinking' || state === 'executing') {
      scale.value = withRepeat(withTiming(1.15, { duration: 550, easing: Easing.inOut(Easing.sin) }), -1, true);
    } else if (state === 'speaking') {
      scale.value = withRepeat(withTiming(1.22, { duration: 320, easing: Easing.inOut(Easing.sin) }), -1, true);
    } else {
      scale.value = withSpring(1);
    }
  }, [state]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <View style={styles.orbWrap}>
      <Animated.View style={[styles.orb, { backgroundColor: withAlpha(accent, 0.16) }, style]}>
        <View style={[styles.orbCore, { backgroundColor: accent }, glow(accent, 0.5, 24)]} />
      </Animated.View>
    </View>
  );
}

export function TalkOverlay({ visible, onClose, onTurnCompleted }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const sessionRef = useRef<RealtimeVoiceSession | null>(null);
  const [state, setState] = useState<RealtimeState>('idle');
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [toolLabel, setToolLabel] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  // KeyboardAvoidingView doesn't reliably push content above the keyboard
  // inside a pageSheet Modal on iOS (confirmed broken here) — AskOverlay hit
  // the same issue and works around it by tracking the keyboard height
  // manually and applying it as bottom padding instead. Mirrors that fix.
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    if (!visible) return;
    connect();
    return () => {
      sessionRef.current?.stop();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const showEv = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEv = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEv, (e) => setKbHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEv, () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, [visible]);

  useEffect(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, [lines]);

  async function connect() {
    // Retry (the error banner's "Retry" button) calls connect() again on an
    // already-mounted overlay — dispose of any prior session first so a
    // failed/half-open attempt doesn't leak its peer connection and mic
    // track underneath the new one.
    sessionRef.current?.stop();
    setError(null);
    setLines([]);
    setToolLabel(null);

    const session = new RealtimeVoiceSession({
      onStateChange: (s) => {
        setState(s);
        if (s === 'listening') setToolLabel(null);
      },
      onTranscript: (role, text, final) => {
        setLines((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === role && !final) {
            return [...prev.slice(0, -1), { role, text: last.text + text }];
          }
          if (last && last.role === role && final) {
            return [...prev.slice(0, -1), { role, text }];
          }
          return [...prev, { role, text }];
        });
      },
      // Fires once the turn is actually SAVED to the shared Ask thread (or
      // was already saved server-side by deep_ask) — not just when the
      // transcript text is done streaming, which can resolve before the
      // save actually happens.
      onTurnPersisted: () => onTurnCompleted?.(),
      onToolStart: (name) => setToolLabel(name === 'deep_ask' ? 'Let me look across your history…' : 'Checking…'),
      onError: (msg) => setError(msg),
    });
    sessionRef.current = session;

    try {
      await session.start();
    } catch (err: any) {
      setState('error');
      // A specific message for what actually went wrong, not one generic
      // string for every failure mode. The old push-to-talk mic is a safe
      // fallback for every one of these codes (see the banner below) —
      // that's a fixed fact of this feature's design, not something that
      // varies per error, so it isn't tracked as separate state.
      setError(messageForErrorCode(err?.code));
    }
  }

  function endSession() {
    sessionRef.current?.stop();
    sessionRef.current = null;
    onClose();
  }

  function toggleMute() {
    const next = !muted;
    sessionRef.current?.setMuted(next);
    setMuted(next);
    Haptics.selectionAsync();
  }

  function tapOrb() {
    if (state === 'speaking') {
      sessionRef.current?.interrupt();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }

  function submitText() {
    const q = textInput.trim();
    if (!q) return;
    sessionRef.current?.sendText(q);
    setLines((prev) => [...prev, { role: 'user', text: q }]);
    setTextInput('');
    Keyboard.dismiss();
  }

  const md = typography;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={endSession}>
      <View style={[styles.sheet, { backgroundColor: c.background, paddingBottom: kbHeight }]}>
        <View style={[styles.header, { borderBottomColor: c.border }]}>
          <Text style={[styles.title, { color: c.text }]}>Talk to NormOS</Text>
          <Pressable onPress={endSession} hitSlop={8}>
            <Text style={[styles.headerBtn, { color: c.accent }]}>End</Text>
          </Pressable>
        </View>

        <ScrollView ref={scrollRef} style={styles.flex} contentContainerStyle={styles.threadContent} keyboardShouldPersistTaps="handled">
          {lines.length === 0 && !error && (
            <Text style={[styles.hint, { color: c.subtext }]}>
              {state === 'connecting' ? 'Connecting…' : 'Say something — I\'m listening.'}
            </Text>
          )}
          {lines.map((l, i) => (
            <Animated.View
              key={i}
              entering={FadeInDown.duration(180).springify().damping(18)}
              style={[
                styles.bubble,
                l.role === 'user'
                  ? { backgroundColor: c.accentSoft, alignSelf: 'flex-end' }
                  : { backgroundColor: 'transparent', alignSelf: 'stretch' },
              ]}
            >
              <Text style={[md.body, { color: c.text }]}>{l.text}</Text>
            </Animated.View>
          ))}
        </ScrollView>

        {error && (
          <View style={[styles.banner, { backgroundColor: withAlpha('#FF3B30', 0.1) }]}>
            <View style={styles.bannerTextCol}>
              <Text style={[styles.bannerText, { color: '#FF3B30' }]}>{error}</Text>
              <Text style={[styles.bannerHint, { color: '#FF3B30' }]}>You can still use the regular mic in Ask.</Text>
            </View>
            <Pressable onPress={connect} hitSlop={8}>
              <Text style={[styles.bannerRetry, { color: '#FF3B30' }]}>Retry</Text>
            </Pressable>
          </View>
        )}

        <View style={styles.presenceArea}>
          <Pressable onPress={tapOrb} disabled={state !== 'speaking'}>
            <PresenceOrb state={state} accent={c.accent} />
          </Pressable>
          <Text style={[styles.stateLabel, { color: c.subtext }]}>{toolLabel || STATE_COPY[state]}</Text>
        </View>

        <View style={[styles.controls, { borderTopColor: c.border }]}>
          {textMode ? (
            <View style={[styles.textRow, { borderColor: c.border, backgroundColor: c.card }]}>
              <TextInput
                style={[styles.textInput, { color: c.text }]}
                placeholder="Type instead…"
                placeholderTextColor={c.subtext}
                value={textInput}
                onChangeText={setTextInput}
                onSubmitEditing={submitText}
                returnKeyType="send"
                autoFocus
              />
              <Pressable onPress={submitText} style={[styles.sendBtn, { backgroundColor: textInput.trim() ? c.accent : c.border }]} disabled={!textInput.trim()}>
                <Text style={styles.sendBtnText}>↑</Text>
              </Pressable>
              <Pressable onPress={() => setTextMode(false)} hitSlop={8} style={{ marginLeft: spacing.sm }}>
                <Ionicons name="mic-outline" size={20} color={c.subtext} />
              </Pressable>
            </View>
          ) : (
            <View style={styles.controlsRow}>
              <Pressable onPress={toggleMute} style={[styles.controlBtn, { backgroundColor: muted ? withAlpha('#FF3B30', 0.12) : c.card, borderColor: c.border }]}>
                <Ionicons name={muted ? 'mic-off' : 'mic'} size={20} color={muted ? '#FF3B30' : c.text} />
              </Pressable>
              <Pressable onPress={() => setTextMode(true)} style={[styles.controlBtn, { backgroundColor: c.card, borderColor: c.border }]}>
                <Ionicons name="keypad-outline" size={20} color={c.text} />
              </Pressable>
              <Pressable onPress={endSession} style={[styles.endBtn, { backgroundColor: '#FF3B30' }]}>
                <Ionicons name="close" size={22} color="#fff" />
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

export { realtimeVoiceAvailable };

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
  threadContent: { padding: spacing.md, paddingBottom: spacing.lg, flexGrow: 1 },
  hint: { fontSize: 14, textAlign: 'center', marginTop: spacing.xl },
  bubble: { borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: 6, marginTop: spacing.sm, maxWidth: '92%' },
  banner: { marginHorizontal: spacing.md, borderRadius: radius.md, padding: spacing.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bannerTextCol: { flex: 1, gap: 2 },
  bannerText: { fontSize: 13, fontWeight: '600' },
  bannerHint: { fontSize: 11, fontWeight: '400', opacity: 0.85 },
  bannerRetry: { fontSize: 13, fontWeight: '700', marginLeft: spacing.sm },
  presenceArea: { alignItems: 'center', paddingVertical: spacing.lg, gap: spacing.sm },
  orbWrap: { width: 96, height: 96, alignItems: 'center', justifyContent: 'center' },
  orb: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center' },
  orbCore: { width: 40, height: 40, borderRadius: 20 },
  stateLabel: { fontSize: 13, fontWeight: '500' },
  controls: { borderTopWidth: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  controlsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  controlBtn: { width: 52, height: 52, borderRadius: 26, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  endBtn: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  textRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 24, paddingLeft: spacing.md, paddingRight: 6, paddingVertical: 6, gap: spacing.sm },
  textInput: { flex: 1, fontSize: 16, paddingVertical: 6 },
  sendBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  sendBtnText: { color: '#fff', fontWeight: '700', fontSize: 18, lineHeight: 20, marginTop: -1 },
});
