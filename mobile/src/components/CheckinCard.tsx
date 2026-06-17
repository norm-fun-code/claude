import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, useColorScheme, AppState } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { CHECKIN_URL, CHECKIN_TODAY_URL, authHeaders, fetchWithTimeout, localDateStr } from '../config';

type Scores = { mood: number | null; energy: number | null; focus: number | null };
const DIMENSIONS: { key: keyof Scores; label: string }[] = [
  { key: 'mood', label: 'Mood' },
  { key: 'energy', label: 'Energy' },
  { key: 'focus', label: 'Focus' },
];

// Dot with spring-bounce and haptic on selection.
function ScoreDot({
  n, active, onPress, c,
}: {
  n: number;
  active: boolean;
  onPress: () => void;
  c: ReturnType<typeof getColors>;
}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePress = () => {
    // Bounce: pop up then settle
    scale.value = withSpring(1.25, { damping: 6, stiffness: 350 }, () => {
      scale.value = withSpring(1, { damping: 14, stiffness: 300 });
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  return (
    <Pressable onPress={handlePress} hitSlop={4}>
      <Animated.View
        style={[
          styles.dot,
          { borderColor: active ? c.accent : c.border },
          active && { backgroundColor: c.accent },
          animStyle,
        ]}
      >
        <Text style={[styles.dotText, { color: active ? '#fff' : c.subtext }]}>{n}</Text>
      </Animated.View>
    </Pressable>
  );
}

export function CheckinCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [scores, setScores] = useState<Scores>({ mood: null, energy: null, focus: null });
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const fetchDateRef = useRef('');

  function todayLocal(): string { return localDateStr(); }

  async function fetchToday() {
    fetchDateRef.current = todayLocal();
    try {
      const res = await fetchWithTimeout(CHECKIN_TODAY_URL, { headers: authHeaders() });
      if (!res.ok) return;
      const t = await res.json();
      if (!t?.logged) return;
      setScores({
        mood: Number.isFinite(t.mood) ? t.mood : null,
        energy: Number.isFinite(t.energy) ? t.energy : null,
        focus: Number.isFinite(t.focus) ? t.focus : null,
      });
      setSaved(true);
    } catch {
      // offline — start blank
    }
  }

  useEffect(() => { fetchToday(); }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && fetchDateRef.current !== todayLocal()) {
        setScores({ mood: null, energy: null, focus: null });
        setSaved(false);
        setFailed(false);
        fetchToday();
      }
    });
    return () => sub.remove();
  }, []);

  function set(key: keyof Scores, value: number) {
    const next = { ...scores, [key]: value };
    setScores(next);
    submit(next);
  }

  async function submit(next: Scores) {
    setFailed(false);
    try {
      const res = await fetchWithTimeout(CHECKIN_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      setSaved(true);
    } catch {
      setSaved(false);
      setFailed(true);
    }
  }

  const complete = scores.mood && scores.energy && scores.focus;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader
        emoji="✅"
        title={complete && saved ? 'Checked in — thanks' : 'How are you today?'}
      />
      {DIMENSIONS.map(({ key, label }) => (
        <View key={key} style={styles.row}>
          <Text style={[styles.label, { color: c.subtext }]}>{label}</Text>
          <View style={styles.scale}>
            {[1, 2, 3, 4, 5].map((n) => (
              <ScoreDot
                key={n}
                n={n}
                active={scores[key] === n}
                onPress={() => set(key, n)}
                c={c}
              />
            ))}
          </View>
        </View>
      ))}
      {failed && (
        <Text style={styles.failed}>Couldn't save — check your connection and tap again.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  label: { ...typography.subtitle, fontSize: 14 },
  scale: { flexDirection: 'row', gap: spacing.sm },
  dot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotText: { ...typography.subtitle, fontSize: 13 },
  failed: { ...typography.caption, color: '#C0392B', marginTop: spacing.sm },
});
