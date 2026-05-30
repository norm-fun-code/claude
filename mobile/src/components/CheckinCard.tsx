import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import { CHECKIN_URL } from '../config';

type Scores = { mood: number | null; energy: number | null; focus: number | null };
const DIMENSIONS: { key: keyof Scores; label: string }[] = [
  { key: 'mood', label: 'Mood' },
  { key: 'energy', label: 'Energy' },
  { key: 'focus', label: 'Focus' },
];

// 10-second daily check-in. This is the subjective signal the intelligence
// layer correlates everything else against.
export function CheckinCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [scores, setScores] = useState<Scores>({ mood: null, energy: null, focus: null });
  const [saved, setSaved] = useState(false);

  function set(key: keyof Scores, value: number) {
    const next = { ...scores, [key]: value };
    setScores(next);
    if (next.mood && next.energy && next.focus) submit(next);
  }

  async function submit(next: Scores) {
    try {
      await fetch(CHECKIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      setSaved(true);
    } catch {
      // offline — user can retry on next refresh
    }
  }

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="✅" title={saved ? 'Checked in — thanks' : 'How are you today?'} />
      {DIMENSIONS.map(({ key, label }) => (
        <View key={key} style={styles.row}>
          <Text style={[styles.label, { color: c.subtext }]}>{label}</Text>
          <View style={styles.scale}>
            {[1, 2, 3, 4, 5].map((n) => {
              const active = scores[key] === n;
              return (
                <Pressable
                  key={n}
                  onPress={() => set(key, n)}
                  style={[
                    styles.dot,
                    { borderColor: c.border },
                    active && { backgroundColor: c.accent, borderColor: c.accent },
                  ]}
                >
                  <Text style={[styles.dotText, { color: active ? c.card : c.subtext }]}>{n}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
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
});
