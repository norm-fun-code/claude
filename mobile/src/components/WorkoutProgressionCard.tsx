import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme, Animated } from 'react-native';
import * as Haptics from 'expo-haptics';
import { SectionHeader } from './SectionHeader';
import { getColors, spacing, radius, shadow } from '../theme';
import { WORKOUT_PROGRESSION_URL, authHeaders, fetchWithTimeout } from '../config';
import { Trend } from './viz/Trend';
import { WorkoutProgressionDetail, type Prog } from './WorkoutProgressionDetail';

// Per-session stats for a chosen metric, computed client-side so the 1RM/Volume
// toggle works without re-fetching.
function statsFor(sessions: Prog['sessions'], metric: 'e1rm' | 'volume' | 'reps') {
  const vals = sessions.map((s) => (s as any)[metric] as number).filter((v) => v > 0);
  if (vals.length < 2) return null;
  const first = vals[0], last = vals[vals.length - 1];
  return { vals, first, last, best: Math.max(...vals), pct: first ? Math.round(((last - first) / first) * 100) : null };
}

// Per-lift progression with a 1RM/Volume toggle and PR badges. Tap a lift for the
// full scrubbable chart. Surfaces on push/pull days once a lift has ≥2 sessions.
export function WorkoutProgressionCard({ exercises, version }: { exercises: string[]; version: number }) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [rows, setRows] = useState<Prog[]>([]);
  const [metricMode, setMetricMode] = useState<'e1rm' | 'volume'>('e1rm');
  const [selected, setSelected] = useState<Prog | null>(null);

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
  const hasWeighted = rows.some((p) => p.metric !== 'reps');
  const prLifts = rows.filter((p) => p.newPR).map((p) => p.exercise);

  return (
    <CardBody
      c={c} isDark={isDark} rows={rows} prLifts={prLifts} hasWeighted={hasWeighted}
      metricMode={metricMode} setMetricMode={setMetricMode} selected={selected} setSelected={setSelected}
    />
  );
}

// Split out so the celebratory animation can fire off `prLifts` cleanly on mount/change.
function CardBody({ c, isDark, rows, prLifts, hasWeighted, metricMode, setMetricMode, selected, setSelected }: {
  c: ReturnType<typeof getColors>; isDark: boolean; rows: Prog[]; prLifts: string[]; hasWeighted: boolean;
  metricMode: 'e1rm' | 'volume'; setMetricMode: (m: 'e1rm' | 'volume') => void;
  selected: Prog | null; setSelected: (p: Prog | null) => void;
}) {
  const pop = useRef(new Animated.Value(0)).current;
  const prKey = prLifts.join('|');
  useEffect(() => {
    if (!prKey) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    pop.setValue(0);
    Animated.spring(pop, { toValue: 1, useNativeDriver: true, friction: 5, tension: 80 }).start();
  }, [prKey]);
  const scale = pop.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] });

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <View style={styles.head}>
        <SectionHeader emoji="📈" title="Strength progression" preserveCase tint="green" />
        {hasWeighted && (
          <View style={styles.toggle}>
            {(['e1rm', 'volume'] as const).map((m) => {
              const on = metricMode === m;
              return (
                <TouchableOpacity
                  key={m}
                  onPress={() => setMetricMode(m)}
                  style={[styles.toggleBtn, { borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accentSoft : 'transparent' }]}
                >
                  <Text style={[styles.toggleTxt, { color: on ? c.accent : c.subtext }]}>{m === 'e1rm' ? '1RM' : 'Volume'}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>

      {prLifts.length > 0 && (
        <Animated.View style={[styles.prBanner, { backgroundColor: c.green + '18', borderColor: c.green, transform: [{ scale }] }]}>
          <Text style={[styles.prBannerTxt, { color: c.green }]}>🏆 New PR — {prLifts.join(', ')}</Text>
        </Animated.View>
      )}

      {rows.map((p) => {
        const eff = p.metric === 'reps' ? 'reps' : metricMode;
        const s = statsFor(p.sessions, eff);
        if (!s) return null;
        const unit = eff === 'reps' ? 'reps' : 'lb';
        const fmt = eff === 'volume' ? (v: number) => Math.round(v).toLocaleString() : (v: number) => `${Math.round(v)}`;
        const metricLabel = eff === 'e1rm' ? 'est. 1RM' : eff === 'volume' ? 'volume' : 'reps';
        const up = s.pct != null && s.pct > 0;
        const flat = s.pct == null || s.pct === 0;
        const chipColor = flat ? c.subtext : up ? c.green : c.red;
        return (
          <TouchableOpacity key={p.exercise} style={[styles.row, { borderTopColor: c.border }]} activeOpacity={0.6} onPress={() => setSelected(p)}>
            <View style={styles.rowHead}>
              <Text style={[styles.exName, { color: c.text }]} numberOfLines={1}>
                {p.exercise}{p.newPR ? '  🏆' : ''}
              </Text>
              {s.pct != null && (
                <Text style={[styles.chip, { color: chipColor }]}>{up ? '↑' : s.pct < 0 ? '↓' : '→'} {Math.abs(s.pct)}%</Text>
              )}
            </View>
            <Text style={[styles.detail, { color: c.subtext }]}>
              {fmt(s.first)} → {fmt(s.last)} {unit} {metricLabel} · {p.n} sessions · best {fmt(s.best)} {unit}
            </Text>
            <View style={styles.spark}>
              <Trend values={s.vals} height={36} color={up ? c.green : flat ? c.subtext : c.red} max={s.vals.length} />
            </View>
          </TouchableOpacity>
        );
      })}
      <Text style={[styles.tapHint, { color: c.subtext }]}>Tap a lift for the full chart</Text>

      <WorkoutProgressionDetail prog={selected} visible={!!selected} onClose={() => setSelected(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  title: { fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  toggle: { flexDirection: 'row', gap: 4 },
  toggleBtn: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  toggleTxt: { fontSize: 11, fontWeight: '700' },
  prBanner: { borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.xs + 2, paddingHorizontal: spacing.sm, marginTop: spacing.xs, alignItems: 'center' },
  prBannerTxt: { fontSize: 13, fontWeight: '700' },
  row: { borderTopWidth: 1, paddingTop: spacing.sm, marginTop: spacing.sm },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  exName: { fontSize: 14, fontWeight: '600', flex: 1, marginRight: spacing.sm },
  chip: { fontSize: 13, fontWeight: '700' },
  detail: { fontSize: 11, marginTop: 2 },
  spark: { marginTop: spacing.xs },
  tapHint: { fontSize: 11, fontStyle: 'italic', textAlign: 'center', marginTop: spacing.sm },
});
