import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ActivityIndicator,
  StyleSheet, useColorScheme,
} from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { METRICS_HISTORY_URL, authHeaders, fetchWithTimeout } from '../config';
import { LineChart } from './viz/LineChart';
import { useContextHistory } from '../hooks/useContextHistory';

// Continuous signals render as lines; cumulative counts stay as bars.
const BAR_METRICS = new Set(['steps', 'active_energy']);

interface DataRow { ts: string; value: number }
interface DayPoint { day: string; value: number }
interface DualPoint { day: string; primary: number | null; secondary: number | null }

export interface DualSourceConfig {
  source: string;
  label: string;
  color: string;
}

export interface MetricConfig {
  metric: string;
  label: string;
  unit: string;
  source?: string;
  sourceLabel?: string;       // display name for the primary source
  dualSource?: DualSourceConfig; // when set, renders grouped bars for both sources
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

function toPoints(rows: DataRow[]): DayPoint[] {
  const map: Record<string, number[]> = {};
  for (const r of rows) {
    const day = r.ts.slice(0, 10);
    if (!map[day]) map[day] = [];
    map[day].push(r.value);
  }
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, vals]) => ({ day, value: vals.reduce((s, v) => s + v, 0) / vals.length }));
}

function trendPct(values: number[]): number | null {
  const half = Math.floor(values.length / 2);
  if (half < 1) return null;
  const recent = values.slice(half).reduce((a, b) => a + b, 0) / values.slice(half).length;
  const prior = values.slice(0, half).reduce((a, b) => a + b, 0) / half;
  return prior !== 0 ? ((recent - prior) / Math.abs(prior)) * 100 : null;
}

// Single-series bar chart — bars fade from soft→accent left→right.
function Sparkline({ points, color, softColor }: { points: DayPoint[]; color: string; softColor: string }) {
  const CHART_H = 80;
  const MIN_H = 4;
  const values = points.map(p => p.value);
  const min = Math.min(...values);
  const range = Math.max(...values) - min;
  const cutoff = Math.max(0, points.length - 7);
  return (
    <View style={{ height: CHART_H, flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}>
      {points.map((p, i) => {
        const frac = range > 0 ? (p.value - min) / range : 1;
        return (
          <View key={p.day} style={{ flex: 1, height: MIN_H + frac * (CHART_H - MIN_H),
            backgroundColor: i >= cutoff ? color : softColor, borderRadius: 2 }} />
        );
      })}
    </View>
  );
}

// Dual-series grouped bar chart — two bars per day, shared scale.
function DualSparkline({ groups, primaryColor, secondaryColor, primarySoft, secondarySoft }:
  { groups: DualPoint[]; primaryColor: string; secondaryColor: string; primarySoft: string; secondarySoft: string }) {
  const CHART_H = 80;
  const MIN_H = 4;
  const allVals = groups.flatMap(g => [g.primary, g.secondary]).filter((v): v is number => v != null);
  if (!allVals.length) return null;
  const min = Math.min(...allVals);
  const range = Math.max(...allVals) - min;
  const toH = (v: number | null) => v == null ? 0 : MIN_H + ((v - min) / (range || 1)) * (CHART_H - MIN_H);
  const cutoff = Math.max(0, groups.length - 7);

  return (
    <View style={{ height: CHART_H, flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}>
      {groups.map((g, i) => {
        const recent = i >= cutoff;
        return (
          <View key={g.day} style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 0.5 }}>
            <View style={{ flex: 1, height: Math.max(toH(g.primary), g.primary != null ? MIN_H : 0),
              backgroundColor: recent ? primaryColor : primarySoft,
              opacity: g.primary == null ? 0.15 : 1, borderRadius: 1.5 }} />
            <View style={{ flex: 1, height: Math.max(toH(g.secondary), g.secondary != null ? MIN_H : 0),
              backgroundColor: recent ? secondaryColor : secondarySoft,
              opacity: g.secondary == null ? 0.15 : 1, borderRadius: 1.5 }} />
          </View>
        );
      })}
    </View>
  );
}

function StatBox({ label, value, valueColor, c }:
  { label: string; value: string; valueColor?: string; c: ReturnType<typeof getColors> }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statBoxLabel, { color: c.subtext }]}>{label}</Text>
      <Text style={[styles.statBoxValue, { color: valueColor ?? c.text }]}>{value}</Text>
    </View>
  );
}

export function MetricDetailSheet({
  metric, label, unit, source, sourceLabel, dualSource,
  formatValue, lowerIsBetter = false, visible, onClose,
}: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [days, setDays] = useState(30);
  const [primaryRows, setPrimaryRows] = useState<DataRow[]>([]);
  const [secondaryRows, setSecondaryRows] = useState<DataRow[]>([]);
  const [loading, setLoading] = useState(false);
  const { contextByDay, notesByDay } = useContextHistory(days, visible);

  const DUAL_SOFT = dualSource ? dualSource.color + '55' : '#FF9F0A55';

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setPrimaryRows([]);
    setSecondaryRows([]);

    const srcParam = source ? `&source=${encodeURIComponent(source)}` : '';
    const p1 = fetchWithTimeout(
      `${METRICS_HISTORY_URL}?metric=${encodeURIComponent(metric)}&days=${days}${srcParam}`,
      { headers: authHeaders() }
    ).then(r => r.json()).then(d => setPrimaryRows(d.rows ?? [])).catch(() => {});

    const promises: Promise<void>[] = [p1];
    if (dualSource) {
      const p2 = fetchWithTimeout(
        `${METRICS_HISTORY_URL}?metric=${encodeURIComponent(metric)}&days=${days}&source=${encodeURIComponent(dualSource.source)}`,
        { headers: authHeaders() }
      ).then(r => r.json()).then(d => setSecondaryRows(d.rows ?? [])).catch(() => {});
      promises.push(p2);
    }
    Promise.all(promises).finally(() => setLoading(false));
  }, [visible, metric, days]);

  const primaryPoints = useMemo(() => toPoints(primaryRows), [primaryRows]);
  const secondaryPoints = useMemo(() => toPoints(secondaryRows), [secondaryRows]);

  // Merge both series into per-day groups for the dual chart.
  const dualGroups = useMemo<DualPoint[]>(() => {
    if (!dualSource) return [];
    const pMap = Object.fromEntries(primaryPoints.map(p => [p.day, p.value]));
    const sMap = Object.fromEntries(secondaryPoints.map(p => [p.day, p.value]));
    const allDays = [...new Set([...Object.keys(pMap), ...Object.keys(sMap)])].sort();
    return allDays.map(day => ({ day, primary: pMap[day] ?? null, secondary: sMap[day] ?? null }));
  }, [primaryPoints, secondaryPoints, dualSource]);

  const isDual = Boolean(dualSource && (primaryPoints.length > 0 || secondaryPoints.length > 0));
  const isEmpty = isDual ? dualGroups.length === 0 : primaryPoints.length === 0;

  // Stats for single-source mode.
  const singleVals = primaryPoints.map(p => p.value);
  const singleAvg = singleVals.length ? singleVals.reduce((a, b) => a + b, 0) / singleVals.length : null;
  const singleTrend = trendPct(singleVals);
  const singleTrendGood = singleTrend != null ? (lowerIsBetter ? singleTrend < 0 : singleTrend > 0) : null;

  // Stats for dual-source mode.
  const primaryVals = dualGroups.map(g => g.primary).filter((v): v is number => v != null);
  const secondaryVals = dualGroups.map(g => g.secondary).filter((v): v is number => v != null);
  const primAvg = primaryVals.length ? primaryVals.reduce((a, b) => a + b, 0) / primaryVals.length : null;
  const secAvg = secondaryVals.length ? secondaryVals.reduce((a, b) => a + b, 0) / secondaryVals.length : null;
  const primTrend = trendPct(primaryVals);
  const secTrend = trendPct(secondaryVals);
  const trendColor = (t: number | null) => t == null ? c.text : (lowerIsBetter ? t < 0 : t > 0) ? c.green : c.red;

  const firstDay = isDual ? dualGroups[0]?.day : primaryPoints[0]?.day;
  const lastDay = isDual ? dualGroups[dualGroups.length - 1]?.day : primaryPoints[primaryPoints.length - 1]?.day;

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

          {/* Legend for dual-source mode */}
          {isDual && (
            <View style={styles.legend}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: c.accent }]} />
                <Text style={[styles.legendTxt, { color: c.subtext }]}>{sourceLabel ?? source ?? 'Primary'}</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: dualSource!.color }]} />
                <Text style={[styles.legendTxt, { color: c.subtext }]}>{dualSource!.label}</Text>
              </View>
            </View>
          )}

          {loading ? (
            <ActivityIndicator color={c.accent} style={{ marginVertical: spacing.xl }} />
          ) : isEmpty ? (
            <Text style={[styles.empty, { color: c.subtext }]}>No data for this period</Text>
          ) : (
            <>
              {BAR_METRICS.has(metric) ? (
                isDual ? (
                  <DualSparkline
                    groups={dualGroups}
                    primaryColor={c.accent}
                    secondaryColor={dualSource!.color}
                    primarySoft={c.accentSoft}
                    secondarySoft={DUAL_SOFT}
                  />
                ) : (
                  <Sparkline points={primaryPoints} color={c.accent} softColor={c.accentSoft} />
                )
              ) : isDual ? (
                <LineChart
                  series={[
                    { values: dualGroups.map((g) => g.primary), color: c.accent, label: sourceLabel ?? 'Primary' },
                    { values: dualGroups.map((g) => g.secondary), color: dualSource!.color, label: dualSource!.label },
                  ]}
                  dates={dualGroups.map((g) => g.day)}
                  unit={unit}
                  formatValue={formatValue}
                  contextByDay={contextByDay}
                  notesByDay={notesByDay}
                />
              ) : (
                <LineChart
                  series={[{ values: primaryPoints.map((p) => p.value), color: c.accent, fill: true }]}
                  dates={primaryPoints.map((p) => p.day)}
                  unit={unit}
                  formatValue={formatValue}
                  contextByDay={contextByDay}
                  notesByDay={notesByDay}
                />
              )}

              {firstDay && lastDay && (
                <View style={styles.dateLabels}>
                  <Text style={[styles.dateLabel, { color: c.subtext }]}>{fmtDate(firstDay)}</Text>
                  <Text style={[styles.dateLabel, { color: c.subtext }]}>{fmtDate(lastDay)}</Text>
                </View>
              )}

              <View style={[styles.statsRow, { borderTopColor: c.border }]}>
                {isDual ? (
                  <>
                    {/* Dual mode: show AVG + TREND for each source */}
                    <View style={styles.statBox}>
                      <View style={[styles.legendDotSm, { backgroundColor: c.accent }]} />
                      <Text style={[styles.statBoxLabel, { color: c.subtext }]}>{sourceLabel ?? 'Primary'}</Text>
                      <Text style={[styles.statBoxValue, { color: c.text }]}>{primAvg != null ? formatValue(primAvg) : '—'}</Text>
                      {primTrend != null && (
                        <Text style={[styles.trendBadge, { color: trendColor(primTrend) }]}>
                          {primTrend > 0 ? '↑' : '↓'} {Math.abs(Math.round(primTrend))}%
                        </Text>
                      )}
                    </View>
                    <View style={[styles.statDivider, { backgroundColor: c.border }]} />
                    <View style={styles.statBox}>
                      <View style={[styles.legendDotSm, { backgroundColor: dualSource!.color }]} />
                      <Text style={[styles.statBoxLabel, { color: c.subtext }]}>{dualSource!.label}</Text>
                      <Text style={[styles.statBoxValue, { color: c.text }]}>{secAvg != null ? formatValue(secAvg) : '—'}</Text>
                      {secTrend != null && (
                        <Text style={[styles.trendBadge, { color: trendColor(secTrend) }]}>
                          {secTrend > 0 ? '↑' : '↓'} {Math.abs(Math.round(secTrend))}%
                        </Text>
                      )}
                    </View>
                  </>
                ) : (
                  <>
                    <StatBox label="MIN" value={formatValue(Math.min(...singleVals))} c={c} />
                    <View style={[styles.statDivider, { backgroundColor: c.border }]} />
                    <StatBox label="AVG" value={singleAvg != null ? formatValue(singleAvg) : '—'} c={c} />
                    <View style={[styles.statDivider, { backgroundColor: c.border }]} />
                    <StatBox label="MAX" value={formatValue(Math.max(...singleVals))} c={c} />
                    {singleTrend !== null && (
                      <>
                        <View style={[styles.statDivider, { backgroundColor: c.border }]} />
                        <StatBox
                          label="TREND"
                          value={`${singleTrend > 0 ? '↑' : '↓'} ${Math.abs(Math.round(singleTrend))}%`}
                          valueColor={singleTrendGood ? c.green : c.red}
                          c={c}
                        />
                      </>
                    )}
                  </>
                )}
              </View>
              <Text style={[styles.caption, { color: c.subtext }]}>
                {unit} · avg vs prior half of period · last {days} days
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
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: spacing.lg, paddingBottom: spacing.xl + 10,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 20,
    shadowOffset: { width: 0, height: -4 }, elevation: 16,
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: spacing.md },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  title: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  closeBtn: { fontSize: 16 },
  periodRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  periodBtn: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.xs + 2, alignItems: 'center' },
  periodTxt: { fontSize: 13, fontWeight: '600' },
  legend: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendTxt: { fontSize: 12, fontWeight: '500' },
  empty: { textAlign: 'center', marginVertical: spacing.xl, fontSize: 13, fontStyle: 'italic' },
  dateLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs, marginBottom: spacing.md },
  dateLabel: { fontSize: 11, fontWeight: '500' },
  statsRow: { flexDirection: 'row', borderTopWidth: 1, paddingTop: spacing.md, marginBottom: spacing.xs },
  statBox: { flex: 1, alignItems: 'center', gap: 2 },
  legendDotSm: { width: 6, height: 6, borderRadius: 3 },
  statDivider: { width: 1, marginVertical: 4 },
  statBoxLabel: { ...typography.label, fontSize: 9, marginBottom: 0 },
  statBoxValue: { fontSize: 17, fontWeight: '600', letterSpacing: -0.3 },
  trendBadge: { fontSize: 11, fontWeight: '600' },
  caption: { fontSize: 11, textAlign: 'center', fontStyle: 'italic', marginTop: spacing.xs },
});
