import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, useColorScheme, ScrollView, TouchableOpacity } from 'react-native';
import { getColors, spacing } from '../theme';
import { CHECKIN_HISTORY_URL, authHeaders, fetchWithTimeout } from '../config';

interface DayEntry {
  date: string;
  mood?: number;
  energy?: number;
  focus?: number;
}

function MiniBar({ value, color }: { value: number | undefined; color: string }) {
  if (value == null) return <View style={[styles.barSlot, { backgroundColor: 'transparent' }]} />;
  const h = Math.round((value / 5) * 28);
  return (
    <View style={styles.barSlot}>
      <View style={[styles.bar, { height: h, backgroundColor: color }]} />
    </View>
  );
}

const METRICS = [
  { key: 'mood' as const, label: 'Mood', color: '#4F8EF7' },
  { key: 'energy' as const, label: 'Energy', color: '#F7A94F' },
  { key: 'focus' as const, label: 'Focus', color: '#4FD18A' },
];

export function CheckinHistoryCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [days, setDays] = useState<DayEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout(`${CHECKIN_HISTORY_URL}?days=30`, { headers: authHeaders() });
      if (res.ok) {
        const json = await res.json();
        setDays(json.days ?? []);
      }
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!loading && days.length === 0) return null;

  // Compute trailing 7-day averages
  const recent = days.slice(-7);
  const avg = (key: 'mood' | 'energy' | 'focus') => {
    const vals = recent.map((d) => d[key]).filter((v): v is number => v != null);
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '—';
  };

  return (
    <View style={[styles.card, { borderColor: c.border, backgroundColor: c.card }]}>
      <Text style={[styles.title, { color: c.text }]}>Check-in trends</Text>
      <Text style={[styles.subtitle, { color: c.subtext }]}>Last 30 days · mood / energy / focus</Text>

      {/* Bar chart — 3 bars per day (mood / energy / focus) */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chartScroll}>
        <View style={styles.chartArea}>
          {days.map((d) => (
            <View key={d.date} style={styles.dayCol}>
              {METRICS.map((m) => (
                <MiniBar key={m.key} value={d[m.key]} color={m.color} />
              ))}
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Legend + 7-day averages */}
      <View style={styles.legend}>
        {METRICS.map((m) => (
          <View key={m.key} style={styles.legendItem}>
            <View style={[styles.dot, { backgroundColor: m.color }]} />
            <Text style={[styles.legendLabel, { color: c.subtext }]}>
              {m.label} <Text style={{ color: c.text, fontWeight: '600' }}>{avg(m.key)}</Text>
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 2 },
  subtitle: { fontSize: 12, marginBottom: spacing.sm },
  chartScroll: { marginBottom: spacing.sm },
  chartArea: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 36,
    gap: 2,
    paddingBottom: 2,
  },
  dayCol: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
  },
  barSlot: {
    width: 4,
    height: 28,
    justifyContent: 'flex-end',
  },
  bar: {
    width: 4,
    borderRadius: 2,
    minHeight: 2,
  },
  legend: {
    flexDirection: 'row',
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { fontSize: 12 },
});
