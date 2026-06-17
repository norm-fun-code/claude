import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, useColorScheme, AppState } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { CHECKIN_URL, CHECKIN_TODAY_URL, authHeaders, fetchWithTimeout } from '../config';

type Scores = { mood: number | null; energy: number | null; focus: number | null };
const DIMENSIONS: { key: keyof Scores; label: string }[] = [
  { key: 'mood', label: 'Mood' },
  { key: 'energy', label: 'Energy' },
  { key: 'focus', label: 'Focus' },
];

// 10-second daily check-in. This is the subjective signal the intelligence
// layer correlates everything else against. Each tap saves immediately (the
// backend upserts one row per metric per day), and we rehydrate today's values
// on mount so switching tabs / reopening shows what you already logged —
// resetting cleanly at midnight in your timezone.
export function CheckinCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [scores, setScores] = useState<Scores>({ mood: null, energy: null, focus: null });
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const fetchDateRef = useRef('');

  function todayET(): string {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }

  // Pre-fill with whatever was already checked in today (survives tab switches).
  async function fetchToday() {
    fetchDateRef.current = todayET();
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

  useEffect(() => {
    fetchToday();
  }, []);

  // When app returns to foreground on a new calendar day, reset and re-fetch so
  // yesterday's scores don't show as today's (iOS keeps app alive for days).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && fetchDateRef.current !== todayET()) {
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
    submit(next); // save every tap, so nothing is lost if you leave mid-way
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
      setFailed(true); // tell the user instead of silently dropping the entry
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
      {failed && (
        <Text style={styles.failed}>Couldn’t save — check your connection and tap again.</Text>
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
