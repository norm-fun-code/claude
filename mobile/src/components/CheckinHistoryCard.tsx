import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { CHECKIN_HISTORY_URL, authHeaders, fetchWithTimeout } from '../config';
import { Insight } from '../hooks/useBriefing';

interface DayEntry {
  date: string;
  mood?: number;
  energy?: number;
  focus?: number;
}

const METRICS = [
  { key: 'mood' as const, label: 'Mood', color: '#4F8EF7' },
  { key: 'energy' as const, label: 'Energy', color: '#F7A94F' },
  { key: 'focus' as const, label: 'Focus', color: '#4FD18A' },
];

const TREND_LABEL: Record<string, string> = {
  habit_consistency: 'STREAK',
  habit_split: 'IMPACT',
  trend: 'TREND',
  anomaly: 'VS YOUR BASELINE',
};

function shortDay(dateStr: string) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2);
}

interface Props {
  insights?: Insight[];
}

export function CheckinHistoryCard({ insights = [] }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [days, setDays] = useState<DayEntry[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`${CHECKIN_HISTORY_URL}?days=7`, { headers: authHeaders() });
      if (res.ok) {
        const json = await res.json();
        setDays(json.days ?? []);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const recent = days.slice(-7);
  if (recent.length === 0 && insights.length === 0) return null;

  const avg = (key: 'mood' | 'energy' | 'focus') => {
    const vals = recent.map((d) => d[key]).filter((v): v is number => v != null);
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '—';
  };

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      {recent.length > 0 && (
        <>
          <Text style={[styles.title, { color: c.text }]}>Check-in Trends</Text>

          {/* Header row: day labels */}
          <View style={styles.grid}>
            <View style={styles.labelCol} />
            {recent.map((d) => (
              <Text key={d.date} style={[styles.dayLabel, { color: c.subtext }]}>
                {shortDay(d.date)}
              </Text>
            ))}
            <Text style={[styles.avgLabel, { color: c.subtext }]}>Avg</Text>
          </View>

          {/* One row per metric */}
          {METRICS.map((m) => (
            <View key={m.key} style={styles.grid}>
              <Text style={[styles.metricLabel, { color: c.subtext }]}>{m.label}</Text>
              {recent.map((d) => {
                const val = d[m.key];
                const opacity = val != null ? 0.3 + (val / 5) * 0.7 : 0.12;
                return (
                  <View key={d.date} style={styles.cell}>
                    <View style={[styles.dot, { backgroundColor: m.color, opacity }]} />
                    <Text style={[styles.cellVal, { color: val != null ? c.text : c.subtext }]}>
                      {val != null ? val : '·'}
                    </Text>
                  </View>
                );
              })}
              <Text style={[styles.cellVal, { color: c.text, fontWeight: '600' }]}>{avg(m.key)}</Text>
            </View>
          ))}
        </>
      )}

      {/* Habit & wellbeing insights below the grid */}
      {insights.length > 0 && (
        <View style={[styles.insightSection, recent.length > 0 && { borderTopColor: c.border, borderTopWidth: 1, marginTop: spacing.sm, paddingTop: spacing.sm }]}>
          {insights.map((ins, i) => (
            <View
              key={ins.dismissKey ?? i}
              style={[styles.insightItem, i > 0 && { borderTopColor: c.border, borderTopWidth: 1 }]}
            >
              <Text style={[styles.insightTag, { color: c.accent }]}>
                {TREND_LABEL[ins.type] ?? ins.type.toUpperCase()}
              </Text>
              <Text style={[styles.insightTitle, { color: c.text }]}>{ins.title}</Text>
              {ins.detail ? <Text style={[styles.insightDetail, { color: c.subtext }]}>{ins.detail}</Text> : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  title: { ...typography.subtitle, marginBottom: spacing.sm },
  grid: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  labelCol: { width: 52 },
  metricLabel: { ...typography.caption, width: 52 },
  dayLabel: { ...typography.caption, flex: 1, textAlign: 'center' },
  avgLabel: { ...typography.caption, width: 32, textAlign: 'right' },
  cell: { flex: 1, alignItems: 'center', gap: 2 },
  dot: { width: 18, height: 18, borderRadius: 9 },
  cellVal: { fontSize: 11, textAlign: 'center', width: 32 },
  insightSection: {},
  insightItem: { paddingTop: spacing.sm, marginTop: spacing.xs },
  insightTag: { ...typography.label, fontSize: 9, marginBottom: 2 },
  insightTitle: { ...typography.subtitle, fontSize: 15, marginBottom: 2 },
  insightDetail: { ...typography.body, fontSize: 13 },
});
