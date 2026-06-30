import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, shadow } from '../theme';
import { WORKOUT_PROGRESSION_URL, authHeaders, fetchWithTimeout } from '../config';
import { Trend } from './viz/Trend';

interface Session { date: string; e1rm: number; volume: number; reps: number; topWeight: number; topReps: number }
interface Prog {
  exercise: string;
  metric: 'e1rm' | 'reps';
  unit: string;
  n: number;
  sessions: Session[];
  delta: { first: number; last: number; pct: number | null } | null;
  best: Session | null;
}

// Per-lift progression over recent sessions — estimated 1RM (or reps for
// bodyweight moves) with a sparkline and the change across the window. Surfaces
// on push/pull days once you've logged sets on ≥2 different days. `version` bumps
// when a set is saved so it picks up today's lifts.
export function WorkoutProgressionCard({ exercises, version }: { exercises: string[]; version: number }) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [rows, setRows] = useState<Prog[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!exercises.length) { setRows([]); return; }
    (async () => {
      try {
        const qs = exercises.map((e) => `exercise=${encodeURIComponent(e)}`).join('&');
        const res = await fetchWithTimeout(`${WORKOUT_PROGRESSION_URL}?${qs}&limit=10`, { headers: authHeaders() });
        if (cancelled || !res.ok) return;
        const { progression } = await res.json();
        if (!cancelled) setRows(progression ?? []);
      } catch { if (!cancelled) setRows([]); }
    })();
    return () => { cancelled = true; };
  }, [exercises.join('|'), version]);

  if (!rows.length) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <Text style={[styles.title, { color: c.text }]}>📈 Strength progression</Text>
      <Text style={[styles.sub, { color: c.subtext }]}>Estimated 1-rep max across your last sessions</Text>

      {rows.map((p) => {
        const vals = p.sessions.filter((s) => (s as any)[p.metric] > 0).map((s) => (s as any)[p.metric] as number);
        const pct = p.delta?.pct ?? null;
        const up = pct != null && pct > 0;
        const flat = pct == null || pct === 0;
        const chipColor = flat ? c.subtext : up ? c.green : c.red;
        const metricLabel = p.metric === 'e1rm' ? 'est. 1RM' : 'reps';
        return (
          <View key={p.exercise} style={[styles.row, { borderTopColor: c.border }]}>
            <View style={styles.rowHead}>
              <Text style={[styles.exName, { color: c.text }]} numberOfLines={1}>{p.exercise}</Text>
              {pct != null && (
                <Text style={[styles.chip, { color: chipColor }]}>
                  {up ? '↑' : pct < 0 ? '↓' : '→'} {Math.abs(pct)}%
                </Text>
              )}
            </View>
            {p.delta && (
              <Text style={[styles.detail, { color: c.subtext }]}>
                {p.delta.first} → {p.delta.last} {p.unit} {metricLabel} · {p.n} sessions
                {p.best ? ` · best ${p.best[p.metric]} ${p.unit}` : ''}
              </Text>
            )}
            {vals.length >= 2 && (
              <View style={styles.spark}>
                <Trend values={vals} height={36} color={up ? c.green : flat ? c.subtext : c.red} max={vals.length} />
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  title: { fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  sub: { fontSize: 12, marginTop: 2, marginBottom: spacing.xs },
  row: { borderTopWidth: 1, paddingTop: spacing.sm, marginTop: spacing.sm },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  exName: { fontSize: 14, fontWeight: '600', flex: 1, marginRight: spacing.sm },
  chip: { fontSize: 13, fontWeight: '700' },
  detail: { fontSize: 11, marginTop: 2 },
  spark: { marginTop: spacing.xs },
});
