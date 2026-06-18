import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ActivityIndicator,
  StyleSheet, useColorScheme,
} from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { METRICS_HISTORY_URL, authHeaders, fetchWithTimeout } from '../config';

interface DataRow { ts: string; value: number }
interface DayPoint { day: string; value: number }

export interface MetricConfig {
  metric: string;
  label: string;
  unit: string;
  formatValue: (v: number) => string;
  lowerIsBetter?: boolean;
}

interface Props extends MetricConfig {
  visible: boolean;
  onClose: () => void;
}

const PERIODS = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '60D', days: 60 },
];

function fmtDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function Sparkline({ points, color, softColor }: { points: DayPoint[]; color: string; softColor: string }) {
  const CHART_H = 80;
  const MIN_BAR_H = 4;
  const values = points.map(p => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const recentCutoff = Math.max(0, points.length - 7);

  return (
    <View style={{ height: CHART_H, flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}>
      {points.map((p, i) => {
        const frac = range > 0 ? (p.value - min) / range : 1;
        const barH = MIN_BAR_H + frac * (CHART_H - MIN_BAR_H);
        return (
          <View
            key={p.day}
            style={{
              flex: 1,
              height: barH,
              backgroundColor: i >= recentCutoff ? color : softColor,
              borderRadius: 2,
            }}
          />
        );
      })}
    </View>
  );
}

function StatBox({
  label, value, valueColor, c,
}: { label: string; value: string; valueColor?: string; c: ReturnType<typeof getColors> }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statBoxLabel, { color: c.subtext }]}>{label}</Text>
      <Text style={[styles.statBoxValue, { color: valueColor ?? c.text }]}>{value}</Text>
    </View>
  );
}

export function MetricDetailSheet({
  metric, label, unit, formatValue, lowerIsBetter = false, visible, onClose,
}: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<DataRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setRows([]);
    fetchWithTimeout(
      `${METRICS_HISTORY_URL}?metric=${encodeURIComponent(metric)}&days=${days}`,
      { headers: authHeaders() }
    )
      .then(r => r.json())
      .then(d => setRows(d.rows ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [visible, metric, days]);

  const points = useMemo<DayPoint[]>(() => {
    const map: Record<string, number[]> = {};
    for (const r of rows) {
      const day = r.ts.slice(0, 10);
      if (!map[day]) map[day] = [];
      map[day].push(r.value);
    }
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, vals]) => ({
        day,
        value: vals.reduce((s, v) => s + v, 0) / vals.length,
      }));
  }, [rows]);

  const values = points.map(p => p.value);
  const minVal = values.length ? Math.min(...values) : 0;
  const maxVal = values.length ? Math.max(...values) : 0;
  const avgVal = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

  const half = Math.floor(values.length / 2);
  const recentAvg = half > 0 ? values.slice(half).reduce((a, b) => a + b, 0) / values.slice(half).length : null;
  const priorAvg = half > 0 ? values.slice(0, half).reduce((a, b) => a + b, 0) / half : null;
  const trendPct = recentAvg != null && priorAvg != null && priorAvg !== 0
    ? ((recentAvg - priorAvg) / Math.abs(priorAvg)) * 100
    : null;
  const trendGood = trendPct != null ? (lowerIsBetter ? trendPct < 0 : trendPct > 0) : null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={StyleSheet.absoluteFill} onPress={onClose} activeOpacity={1} />
        <View style={[styles.sheet, { backgroundColor: c.card }]}>
          <View style={[styles.handle, { backgroundColor: c.border }]} />

          <View style={styles.header}>
            <Text style={[styles.title, { color: c.text }]}>{label}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Text style={[styles.closeBtn, { color: c.subtext }]}>✕</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.periodRow}>
            {PERIODS.map(p => (
              <TouchableOpacity
                key={p.days}
                onPress={() => setDays(p.days)}
                style={[styles.periodBtn, {
                  backgroundColor: days === p.days ? c.accent : 'transparent',
                  borderColor: days === p.days ? c.accent : c.border,
                }]}
              >
                <Text style={[styles.periodTxt, { color: days === p.days ? '#fff' : c.subtext }]}>
                  {p.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {loading ? (
            <ActivityIndicator color={c.accent} style={{ marginVertical: spacing.xl }} />
          ) : points.length === 0 ? (
            <Text style={[styles.empty, { color: c.subtext }]}>No data for this period</Text>
          ) : (
            <>
              <Sparkline points={points} color={c.accent} softColor={c.accentSoft} />
              <View style={styles.dateLabels}>
                <Text style={[styles.dateLabel, { color: c.subtext }]}>{fmtDate(points[0].day)}</Text>
                <Text style={[styles.dateLabel, { color: c.subtext }]}>{fmtDate(points[points.length - 1].day)}</Text>
              </View>

              <View style={[styles.statsRow, { borderTopColor: c.border }]}>
                <StatBox label="MIN" value={formatValue(minVal)} c={c} />
                <View style={[styles.statDivider, { backgroundColor: c.border }]} />
                <StatBox label="AVG" value={avgVal !== null ? formatValue(avgVal) : '—'} c={c} />
                <View style={[styles.statDivider, { backgroundColor: c.border }]} />
                <StatBox label="MAX" value={formatValue(maxVal)} c={c} />
                {trendPct !== null && (
                  <>
                    <View style={[styles.statDivider, { backgroundColor: c.border }]} />
                    <StatBox
                      label="TREND"
                      value={`${trendPct > 0 ? '↑' : '↓'} ${Math.abs(Math.round(trendPct))}%`}
                      valueColor={trendGood ? c.green : c.red}
                      c={c}
                    />
                  </>
                )}
              </View>
              <Text style={[styles.caption, { color: c.subtext }]}>
                {unit} · last {days} days
              </Text>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.lg,
    paddingBottom: spacing.xl + 10,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -4 },
    elevation: 16,
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: spacing.md },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  title: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  closeBtn: { fontSize: 16 },
  periodRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  periodBtn: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.xs + 2, alignItems: 'center' },
  periodTxt: { fontSize: 13, fontWeight: '600' },
  empty: { textAlign: 'center', marginVertical: spacing.xl, fontSize: 13, fontStyle: 'italic' },
  dateLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs, marginBottom: spacing.md },
  dateLabel: { fontSize: 11, fontWeight: '500' },
  statsRow: { flexDirection: 'row', borderTopWidth: 1, paddingTop: spacing.md, marginBottom: spacing.xs },
  statBox: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, marginVertical: 4 },
  statBoxLabel: { ...typography.label, fontSize: 9, marginBottom: 2 },
  statBoxValue: { fontSize: 17, fontWeight: '600', letterSpacing: -0.3 },
  caption: { fontSize: 11, textAlign: 'center', fontStyle: 'italic', marginTop: spacing.xs },
});
