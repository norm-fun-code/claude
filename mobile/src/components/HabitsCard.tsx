import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, useColorScheme, AppState, Animated } from 'react-native';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { API_BASE, HABITS_STREAKS_URL, HABITS_TODAY_URL, HABITS_HISTORY_URL, authHeaders, fetchWithTimeout, localDateStr } from '../config';
import { AnnotationsCard } from './AnnotationsCard';
import { DotRow } from './viz/DotRow';
import { EatHealthyHelper } from './EatHealthyHelper';
import { GratitudeReflection } from './GratitudeReflection';

const HABITS_URL = `${API_BASE}/api/habits`;

type Binary = 'morningTM' | 'afternoonTM' | 'gratitude' | 'exercise';

const HABITS: { key: Binary; label: string }[] = [
  { key: 'morningTM', label: 'Morning TM' },
  { key: 'afternoonTM', label: 'Afternoon TM' },
  { key: 'gratitude', label: 'Gratitude Journal' },
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
    exercise: false,
  });
  const [streaks, setStreaks] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<Record<string, boolean[]>>({});
  const [eatHealthy, setEatHealthy] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const fetchDateRef = useRef('');

  function todayLocal(): string { return localDateStr(); }

  // Pre-fill with whatever was already logged today (survives reopening).
  async function fetchToday() {
    fetchDateRef.current = todayLocal();
    try {
      const res = await fetchWithTimeout(HABITS_TODAY_URL, { headers: authHeaders() });
      if (!res.ok) return;
      const t = await res.json();
      if (!t?.logged) return;
      setChecked({
        morningTM: !!t.morningTM,
        afternoonTM: !!t.afternoonTM,
        gratitude: !!t.gratitude,
        exercise: !!t.exercise,
      });
      if (Number.isFinite(t.eatHealthy)) setEatHealthy(t.eatHealthy);
      setSaved(true);
    } catch {
      // offline — start blank
    }
  }

  async function fetchStreaks() {
    fetchWithTimeout(HABITS_STREAKS_URL, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.streaks) setStreaks(d.streaks); })
      .catch(() => {});
  }

  async function fetchHistory() {
    fetchWithTimeout(`${HABITS_HISTORY_URL}?days=14`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.history) setHistory(d.history); })
      .catch(() => {});
  }

  useEffect(() => {
    fetchToday();
  }, []);

  useEffect(() => {
    fetchStreaks();
    fetchHistory();
  }, []);

  // When app returns to foreground on a new calendar day, reset and re-fetch so
  // yesterday's habits don't show as today's (iOS keeps app alive for days).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && fetchDateRef.current !== todayLocal()) {
        setChecked({ morningTM: false, afternoonTM: false, gratitude: false, exercise: false });
        setEatHealthy(null);
        setSaved(false);
        setFailed(false);
        fetchToday();
      }
    });
    return () => sub.remove();
  }, []);

  // Persist the full current state. Each box tap saves immediately (the backend
  // upserts one row per habit per day), so nothing is lost if you don't tap
  // "Save" — and it rehydrates on return, resetting at midnight.
  async function save(nextChecked = checked, nextEat = eatHealthy, extra: Record<string, unknown> = {}) {
    setFailed(false);
    try {
      const res = await fetchWithTimeout(HABITS_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ ...nextChecked, eatHealthy: nextEat, ...extra }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      setSaved(true);
    } catch {
      setSaved(false);
      setFailed(true);
    }
  }

  // Completion moment: checking the last habit earns a soft success chord and a
  // one-breath scale pulse on the card — a quiet ritual close, not confetti.
  const pulse = useRef(new Animated.Value(1)).current;

  function toggle(key: Binary) {
    const next = { ...checked, [key]: !checked[key] };
    const nextDone = Object.values(next).filter(Boolean).length;
    if (nextDone === HABITS.length) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      Animated.sequence([
        Animated.spring(pulse, { toValue: 1.02, useNativeDriver: true, damping: 9, stiffness: 300 }),
        Animated.spring(pulse, { toValue: 1, useNativeDriver: true, damping: 14, stiffness: 260 }),
      ]).start();
    } else {
      Haptics.selectionAsync();
    }
    setChecked(next);
    const extra: Record<string, unknown> = {};
    if (key === 'exercise' && next.exercise) extra.exerciseCompletedAt = new Date().toISOString();
    save(next, eatHealthy, extra);
  }

  const doneCount = Object.values(checked).filter(Boolean).length;

  return (
    <Animated.View style={[styles.card, { backgroundColor: c.card, transform: [{ scale: pulse }] }, shadow(isDark)]}>
      <SectionHeader emoji="🔁" title={saved ? 'Habits logged — nice' : 'Habit Stack'} />

      {HABITS.map(({ key, label }) => {
        const on = checked[key];
        const hist = history[key];
        return (
          <React.Fragment key={key}>
            <Pressable onPress={() => toggle(key)} style={styles.habitItem}>
              <View style={styles.row}>
                <View style={styles.labelRow}>
                  <Text style={[styles.label, { color: c.text }]}>{label}</Text>
                  {(streaks[key] ?? 0) > 0 && (
                    <Text style={[styles.streak, { color: c.subtext }]}>
                      {streaks[key]}d
                    </Text>
                  )}
                </View>
                <View
                  style={[
                    styles.box,
                    { borderColor: c.border },
                    on && { backgroundColor: c.accent, borderColor: c.accent },
                  ]}
                >
                  {on && <Text style={styles.check}>✓</Text>}
                </View>
              </View>
              {hist && hist.length >= 7 && (
                <View style={styles.habitDots}>
                  <DotRow values={hist} size={6} gap={3} max={14} activeColor={c.accent} inactiveColor={c.border} />
                </View>
              )}
            </Pressable>
            {/* Gratitude is the one habit with a reflective practice attached:
                naming what you're grateful for (optional) both logs the habit and
                feeds the evening wind-down brief. */}
            {key === 'gratitude' && (
              <GratitudeReflection
                onSaved={() => {
                  const next = { ...checked, gratitude: true };
                  setChecked(next);
                  save(next, eatHealthy);
                }}
              />
            )}
          </React.Fragment>
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
                  save(checked, n); // save on every tap
                }}
                style={[styles.dot, { borderColor: c.border }, active && { backgroundColor: c.accent, borderColor: c.accent }]}
              >
                <Text style={[styles.dotText, { color: active ? '#FFFFFF' : c.subtext }]}>{n}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <EatHealthyHelper onApply={(n) => { setEatHealthy(n); save(checked, n); }} />

      <Pressable onPress={() => save()} style={[styles.save, { backgroundColor: saved ? c.accentSoft : c.accent }]}>
        <Text style={[styles.saveText, { color: saved ? c.accent : '#FFFFFF' }]}>
          {failed ? 'Retry save' : saved ? `Saved · ${doneCount}/${HABITS.length} habits` : 'Save today'}
        </Text>
      </Pressable>
      {failed && (
        <Text style={styles.failed}>Couldn't save — check your connection and tap Retry.</Text>
      )}
      <View style={[styles.contextDivider, { borderTopColor: c.border }]}>
        <AnnotationsCard inline />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  habitItem: {},
  habitDots: { marginTop: -spacing.xs, paddingBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  labelRow: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  label: { ...typography.subtitle, fontSize: 15 },
  streak: { fontSize: 12, fontWeight: '500', marginLeft: 4 },
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
  failed: { ...typography.caption, color: '#C0392B', marginTop: spacing.sm, textAlign: 'center' },
  contextDivider: { marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1 },
});
