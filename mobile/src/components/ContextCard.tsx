import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, useColorScheme, AppState, Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { ANNOTATIONS_URL, authHeaders, fetchWithTimeout, localTz, localDateStr } from '../config';

type Preset = { emoji: string; category: string; label: string };
const PRESETS: Preset[] = [
  { emoji: '✈️', category: 'travel', label: 'Travel' },
  { emoji: '🤒', category: 'illness', label: 'Feeling sick' },
  { emoji: '😴', category: 'sleep', label: 'Poor sleep' },
  { emoji: '🌙', category: 'late_night', label: 'Late night' },
  { emoji: '🍷', category: 'alcohol', label: 'Drinking' },
  { emoji: '🔥', category: 'stress', label: 'High stress' },
  { emoji: '📅', category: 'deadline', label: 'Big deadline' },
  { emoji: '🎉', category: 'social', label: 'Social event' },
  { emoji: '🧘', category: 'rest', label: 'Rest day' },
];

type Logged = { id: string; category: string; label: string };

// Individual chip with spring-scale press and haptic feedback.
function Chip({
  p, on, busy, onTap, c,
}: {
  p: Preset;
  on: boolean;
  busy: boolean;
  onTap: () => void;
  c: ReturnType<typeof getColors>;
}) {
  const scale = useSharedValue(1);
  const chipAnimStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePress = () => {
    scale.value = withSpring(0.9, { damping: 10, stiffness: 400 }, () => {
      scale.value = withSpring(1, { damping: 12, stiffness: 300 });
    });
    Haptics.selectionAsync();
    onTap();
  };

  return (
    <Pressable onPress={handlePress} disabled={busy}>
      <Animated.View
        style={[
          styles.chip,
          {
            borderColor: on ? c.accent : c.border,
            backgroundColor: on ? c.accent : 'transparent',
            opacity: busy ? 0.5 : 1,
          },
          chipAnimStyle,
        ]}
      >
        <Text style={[styles.chipText, { color: on ? '#fff' : c.text }]}>
          {p.emoji} {p.label}{on ? ' ✓' : ''}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

export function ContextCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [logged, setLogged] = useState<Logged[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const fetchDateRef = useRef('');

  // Use device timezone so the day resets at local midnight even when travelling.
  function todayLocal(): string {
    return localDateStr();
  }

  function startOfTodayISO(): string {
    return `${localDateStr()}T00:00:00`;
  }

  async function fetchToday() {
    fetchDateRef.current = todayLocal();
    try {
      const res = await fetchWithTimeout(`${ANNOTATIONS_URL}?from=${encodeURIComponent(startOfTodayISO())}`, {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const { annotations } = await res.json();
      if (!Array.isArray(annotations)) return;
      setLogged(annotations.map((a: any) => ({ id: a.id, category: a.category, label: a.label })));
    } catch {
      // offline — show presets unmarked
    }
  }

  useEffect(() => { fetchToday(); }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && fetchDateRef.current !== todayLocal()) {
        setLogged([]);
        setNote('');
        setFailed(false);
        fetchToday();
      }
    });
    return () => sub.remove();
  }, []);

  const isLogged = (label: string) => logged.some((l) => l.label === label);
  const getLogged = (label: string) => logged.find((l) => l.label === label);

  async function log(category: string, label: string) {
    if (saving) return;
    setSaving(label);
    setFailed(false);
    try {
      const res = await fetchWithTimeout(ANNOTATIONS_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ startTs: new Date().toISOString(), category, label }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const { id } = await res.json();
      setLogged((prev) => [{ id, category, label }, ...prev]);
    } catch {
      setFailed(true);
    } finally {
      setSaving(null);
    }
  }

  async function unlog(id: string, label: string) {
    if (saving) return;
    setSaving(label);
    setFailed(false);
    try {
      const res = await fetchWithTimeout(`${ANNOTATIONS_URL}/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      setLogged((prev) => prev.filter((l) => l.id !== id));
    } catch {
      setFailed(true);
    } finally {
      setSaving(null);
    }
  }

  async function logNote() {
    const text = note.trim();
    if (!text) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await log('note', text);
    setNote('');
  }

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="📝" title="Anything going on today?" />
      <Text style={[styles.hint, { color: c.subtext }]}>
        Tap to log — tap again to remove. NormOS uses it to explain your numbers.
      </Text>

      <View style={styles.chips}>
        {PRESETS.map((p) => {
          const on = isLogged(p.label);
          const busy = saving === p.label;
          return (
            <Chip
              key={p.label}
              p={p}
              on={on}
              busy={busy}
              c={c}
              onTap={() => {
                if (on) {
                  const entry = getLogged(p.label);
                  if (entry) unlog(entry.id, p.label);
                } else {
                  log(p.category, p.label);
                }
              }}
            />
          );
        })}
      </View>

      <View style={styles.noteRow}>
        <TextInput
          style={[styles.noteInput, { color: c.text, borderColor: c.border }]}
          placeholder="Something else…"
          placeholderTextColor={c.subtext}
          value={note}
          onChangeText={setNote}
          returnKeyType="done"
          onSubmitEditing={logNote}
        />
        <TouchableOpacity
          onPress={logNote}
          disabled={!note.trim() || saving === note.trim()}
          style={[styles.addBtn, { backgroundColor: c.accent, opacity: note.trim() ? 1 : 0.4 }]}
        >
          <Text style={styles.addBtnText}>Add</Text>
        </TouchableOpacity>
      </View>

      {logged.filter((l) => !PRESETS.some((p) => p.label === l.label)).map((l) => (
        <View key={l.id} style={styles.customRow}>
          <Text style={[styles.customText, { color: c.subtext }]}>✓ {l.label}</Text>
        </View>
      ))}

      {failed && <Text style={styles.failed}>Couldn't save — check your connection and try again.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  hint: { ...typography.caption, fontSize: 13, marginBottom: spacing.md, lineHeight: 19 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipText: { ...typography.body, fontSize: 14, fontWeight: '600' },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  noteInput: {
    flex: 1,
    ...typography.body,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  addBtn: { borderRadius: radius.md, paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.lg },
  addBtnText: { ...typography.body, fontWeight: '700', color: '#fff' },
  customRow: { marginTop: spacing.sm },
  customText: { ...typography.caption, fontSize: 13 },
  failed: { ...typography.caption, color: '#C0392B', marginTop: spacing.sm },
});
