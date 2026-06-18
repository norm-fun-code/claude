import React, { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, Pressable, TextInput,
  useColorScheme, KeyboardAvoidingView, Platform, AppState,
} from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, FadeIn, FadeOut,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { CHECKIN_URL, CHECKIN_TODAY_URL, authHeaders, fetchWithTimeout, localDateStr } from '../config';

interface Props {
  visible: boolean;
  onClose: () => void;
}

type Scores = { energy: number | null; mood: number | null; focus: number | null };

// Step order: energy first (most physical → sets the frame), then mood, then focus.
const STEPS: { key: keyof Scores; label: string; hint: string }[] = [
  { key: 'energy', label: 'Energy',   hint: 'Body — how charged do you feel?' },
  { key: 'mood',   label: 'Mood',     hint: 'Mind — how are you doing emotionally?' },
  { key: 'focus',  label: 'Focus',    hint: 'Presence — how sharp is your attention?' },
];

function Dot({ n, active, onPress, c }: {
  n: number; active: boolean;
  onPress: () => void;
  c: ReturnType<typeof getColors>;
}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePress = () => {
    scale.value = withSpring(1.3, { damping: 5, stiffness: 380 }, () => {
      scale.value = withSpring(1, { damping: 14, stiffness: 300 });
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  return (
    <Pressable onPress={handlePress} hitSlop={6}>
      <Animated.View style={[
        styles.dot,
        { borderColor: active ? c.accent : c.border },
        active && { backgroundColor: c.accent },
        animStyle,
      ]}>
        <Text style={[styles.dotText, { color: active ? '#fff' : c.subtext }]}>{n}</Text>
      </Animated.View>
    </Pressable>
  );
}

export function CheckinModal({ visible, onClose }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const [scores, setScores] = useState<Scores>({ energy: null, mood: null, focus: null });
  const [step, setStep] = useState(0); // 0–2 = score steps, 3 = note/done
  const [note, setNote] = useState('');
  const noteRef = useRef('');
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const fetchDateRef = useRef('');

  const progressOpacity = useSharedValue(1);
  const progressStyle = useAnimatedStyle(() => ({ opacity: progressOpacity.value }));

  async function fetchToday() {
    fetchDateRef.current = localDateStr();
    try {
      const res = await fetchWithTimeout(CHECKIN_TODAY_URL, { headers: authHeaders() });
      if (!res.ok) return;
      const t = await res.json();
      if (!t?.logged) return;
      const loaded: Scores = {
        energy: Number.isFinite(t.energy) ? t.energy : null,
        mood: Number.isFinite(t.mood) ? t.mood : null,
        focus: Number.isFinite(t.focus) ? t.focus : null,
      };
      setScores(loaded);
      if (t.note) { setNote(t.note); noteRef.current = t.note; }
      setSaved(true);
      // If already logged, jump straight to note/done step
      if (loaded.energy && loaded.mood && loaded.focus) setStep(3);
    } catch { /* offline */ }
  }

  useEffect(() => {
    if (!visible) return;
    fetchToday();
  }, [visible]);

  // Reset on day boundary
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && fetchDateRef.current !== localDateStr()) {
        setScores({ energy: null, mood: null, focus: null });
        setNote(''); noteRef.current = '';
        setSaved(false); setFailed(false); setStep(0);
      }
    });
    return () => sub.remove();
  }, []);

  async function submit(next: Scores, noteText = '') {
    setFailed(false);
    try {
      const body: Record<string, unknown> = { ...next };
      if (noteText.trim()) body.note = noteText.trim();
      const res = await fetchWithTimeout(CHECKIN_URL, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setSaved(true);
    } catch { setFailed(true); }
  }

  function pick(key: keyof Scores, value: number) {
    const next = { ...scores, [key]: value };
    setScores(next);
    submit(next, noteRef.current);

    // Fade out → advance step → fade in
    progressOpacity.value = withTiming(0, { duration: 120 }, () => {
      progressOpacity.value = withTiming(1, { duration: 180 });
    });
    setTimeout(() => {
      setStep((s) => Math.min(s + 1, 3));
    }, 180);
  }

  const currentStep = STEPS[step];
  const allDone = scores.energy && scores.mood && scores.focus;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={[styles.sheet, { backgroundColor: c.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Drag handle */}
        <View style={styles.handleWrap}>
          <View style={[styles.handle, { backgroundColor: c.border }]} />
        </View>

        {/* Progress dots */}
        <View style={styles.progressRow}>
          {STEPS.map((s, i) => (
            <View
              key={s.key}
              style={[
                styles.progressDot,
                { backgroundColor: i <= step ? c.accent : c.border },
              ]}
            />
          ))}
        </View>

        {step < 3 ? (
          /* ── Score step ── */
          <Animated.View style={[styles.stepWrap, progressStyle]}>
            <Text style={[styles.stepLabel, { color: c.subtext }]}>{currentStep.hint}</Text>
            <Text style={[styles.stepTitle, { color: c.text }]}>{currentStep.label}</Text>
            <View style={styles.scaleRow}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Dot
                  key={n}
                  n={n}
                  active={scores[currentStep.key] === n}
                  onPress={() => pick(currentStep.key, n)}
                  c={c}
                />
              ))}
            </View>
            <Text style={[styles.scaleHint, { color: c.subtext }]}>1 = low · 5 = high</Text>
          </Animated.View>
        ) : (
          /* ── Note + Done step ── */
          <Animated.View entering={FadeIn.duration(200)} style={styles.stepWrap}>
            {allDone && (
              <Text style={[styles.doneTitle, { color: c.text }]}>
                {saved ? 'Checked in ✓' : 'One moment…'}
              </Text>
            )}
            <TextInput
              style={[styles.noteInput, { color: c.text, borderColor: c.border, backgroundColor: c.card }]}
              placeholder="Anything on your mind? (optional)"
              placeholderTextColor={c.subtext}
              value={note}
              onChangeText={(text) => { setNote(text); noteRef.current = text; }}
              onBlur={() => submit(scores, noteRef.current)}
              multiline
              maxLength={500}
              autoFocus={!allDone}
            />
            {/* Show all three scores so user can edit any */}
            <View style={styles.summaryRow}>
              {STEPS.map(({ key, label }) => (
                <View key={key} style={styles.summaryItem}>
                  <Text style={[styles.summaryLabel, { color: c.subtext }]}>{label}</Text>
                  <View style={styles.miniScale}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Pressable
                        key={n}
                        onPress={() => {
                          const next = { ...scores, [key]: n };
                          setScores(next);
                          submit(next, noteRef.current);
                        }}
                        hitSlop={4}
                      >
                        <View style={[
                          styles.miniDot,
                          { borderColor: scores[key] === n ? c.accent : c.border },
                          scores[key] === n && { backgroundColor: c.accent },
                        ]} />
                      </Pressable>
                    ))}
                  </View>
                </View>
              ))}
            </View>
            {failed && (
              <Text style={[styles.error, { color: '#C0392B' }]}>Couldn't save — check connection.</Text>
            )}
            <Pressable
              onPress={onClose}
              style={[styles.doneBtn, { backgroundColor: c.accent }]}
            >
              <Text style={styles.doneBtnText}>Done</Text>
            </Pressable>
          </Animated.View>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, paddingHorizontal: spacing.lg },
  handleWrap: { alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.xs },
  handle: { width: 36, height: 4, borderRadius: 2 },
  progressRow: { flexDirection: 'row', gap: 6, justifyContent: 'center', marginBottom: spacing.xl },
  progressDot: { width: 24, height: 4, borderRadius: 2 },
  stepWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 60 },
  stepLabel: { ...typography.caption, fontSize: 13, marginBottom: spacing.xs, textAlign: 'center' },
  stepTitle: { fontSize: 32, fontWeight: '700', letterSpacing: -0.5, marginBottom: spacing.xl },
  scaleRow: { flexDirection: 'row', gap: spacing.md },
  scaleHint: { ...typography.caption, marginTop: spacing.md },
  dot: {
    width: 48, height: 48, borderRadius: 24,
    borderWidth: 1.5, alignItems: 'center', justifyContent: 'center',
  },
  dotText: { fontSize: 17, fontWeight: '600' },
  doneTitle: { fontSize: 22, fontWeight: '700', marginBottom: spacing.lg },
  noteInput: {
    width: '100%', borderWidth: 1, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    fontSize: 15, minHeight: 80, textAlignVertical: 'top', marginBottom: spacing.lg,
  },
  summaryRow: { flexDirection: 'row', gap: spacing.lg, marginBottom: spacing.lg },
  summaryItem: { alignItems: 'center', gap: 6 },
  summaryLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },
  miniScale: { flexDirection: 'row', gap: 4 },
  miniDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5 },
  error: { fontSize: 13, marginBottom: spacing.sm },
  doneBtn: {
    width: '100%', paddingVertical: spacing.md,
    borderRadius: radius.md, alignItems: 'center',
  },
  doneBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
