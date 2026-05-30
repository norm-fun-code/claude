import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import { API_BASE, authHeaders } from '../config';

const HABITS_URL = `${API_BASE}/api/habits`;
const HABITS_TODAY_URL = `${API_BASE}/api/habits/today`;

type Binary = 'morningTM' | 'afternoonTM' | 'gratitude' | 'coldShower' | 'exercise';

const HABITS: { key: Binary; label: string }[] = [
  { key: 'morningTM', label: 'Morning TM' },
  { key: 'afternoonTM', label: 'Afternoon TM' },
  { key: 'gratitude', label: 'Gratitude Journal' },
  { key: 'coldShower', label: 'Cold Shower' },
  { key: 'exercise', label: 'Exercise' },
];

// End-of-day habit stack. Each toggle is a daily 0/1 metric; Eat Healthy is
// 1–5. These correlate against HRV, sleep, mood, and focus in Insights.
export function HabitsCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [checked, setChecked] = useState<Record<Binary, boolean>>({
    morningTM: false,
    afternoonTM: false,
    gratitude: false,
    coldShower: false,
    exercise: false,
  });
  const [eatHealthy, setEatHealthy] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);

  // Pre-fill with whatever was already logged today (survives reopening).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(HABITS_TODAY_URL, { headers: authHeaders() });
        if (!res.ok) return;
        const t = await res.json();
        if (cancelled || !t?.logged) return;
        setChecked({
          morningTM: !!t.morningTM,
          afternoonTM: !!t.afternoonTM,
          gratitude: !!t.gratitude,
          coldShower: !!t.coldShower,
          exercise: !!t.exercise,
        });
        if (Number.isFinite(t.eatHealthy)) setEatHealthy(t.eatHealthy);
        setSaved(true);
      } catch {
        // offline — start blank
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(key: Binary) {
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }));
    setSaved(false);
  }

  async function save() {
    try {
      await fetch(HABITS_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ ...checked, eatHealthy }),
      });
      setSaved(true);
    } catch {
      // offline — try again on next refresh
    }
  }

  const doneCount = Object.values(checked).filter(Boolean).length;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="🔁" title={saved ? 'Habits logged — nice' : 'Habit Stack'} />

      {HABITS.map(({ key, label }) => {
        const on = checked[key];
        return (
          <Pressable key={key} onPress={() => toggle(key)} style={styles.row}>
            <Text style={[styles.label, { color: c.text }]}>{label}</Text>
            <View
              style={[
                styles.box,
                { borderColor: c.border },
                on && { backgroundColor: c.accent, borderColor: c.accent },
              ]}
            >
              {on && <Text style={styles.check}>✓</Text>}
            </View>
          </Pressable>
        );
      })}

      {/* Eat Healthy — 1 (least) to 5 (healthiest) */}
      <View style={[styles.eatRow, { borderTopColor: c.border }]}>
        <Text style={[styles.label, { color: c.text }]}>Eat Healthy</Text>
        <View style={styles.scale}>
          {[1, 2, 3, 4, 5].map((n) => {
            const active = eatHealthy === n;
            return (
              <Pressable
                key={n}
                onPress={() => {
                  setEatHealthy(n);
                  setSaved(false);
                }}
                style={[styles.dot, { borderColor: c.border }, active && { backgroundColor: c.accent, borderColor: c.accent }]}
              >
                <Text style={[styles.dotText, { color: active ? '#FFFFFF' : c.subtext }]}>{n}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Pressable onPress={save} style={[styles.save, { backgroundColor: saved ? c.accentSoft : c.accent }]}>
        <Text style={[styles.saveText, { color: saved ? c.accent : '#FFFFFF' }]}>
          {saved ? `Saved · ${doneCount}/5 habits` : 'Save today'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  label: { ...typography.subtitle, fontSize: 15 },
  box: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  check: { color: '#FFFFFF', fontSize: 15, fontWeight: '700', lineHeight: 18 },
  eatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.md,
    marginTop: spacing.xs,
    borderTopWidth: 1,
  },
  scale: { flexDirection: 'row', gap: spacing.xs },
  dot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotText: { ...typography.subtitle, fontSize: 13 },
  save: {
    marginTop: spacing.md,
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  saveText: { fontWeight: '700', fontSize: 15 },
});
