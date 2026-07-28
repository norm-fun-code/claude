import React, { useEffect, useState } from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius } from '../theme';
import { LineChart, type ContextNote } from './viz/LineChart';
import SheetHandle from './SheetHandle';

interface Session { date: string; e1rm: number; volume: number; reps: number; topWeight: number; topReps: number }
export interface Prog {
  exercise: string;
  metric: 'e1rm' | 'reps';
  unit: string;
  n: number;
  sessions: Session[];
  newPR?: boolean;
}

const fmtDate = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// Full progression for one lift — scrub the line to read each session's top set,
// est. 1RM, and volume. Weighted lifts can toggle est. 1RM ↔ volume.
export function WorkoutProgressionDetail({ prog, visible, onClose }: { prog: Prog | null; visible: boolean; onClose: () => void }) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const weighted = prog?.metric !== 'reps';
  const [metric, setMetric] = useState<'e1rm' | 'volume' | 'reps'>('e1rm');

  useEffect(() => { if (prog) setMetric(prog.metric === 'reps' ? 'reps' : 'e1rm'); }, [prog?.exercise]);

  if (!prog) return null;
  const sessions = prog.sessions;
  const eff = weighted ? metric : 'reps';
  const unit = eff === 'reps' ? 'reps' : 'lb';
  const fmt = eff === 'volume' ? (v: number) => Math.round(v).toLocaleString() : (v: number) => `${Math.round(v)}`;
  const vals = sessions.map((s) => { const v = (s as any)[eff] as number; return v > 0 ? v : null; });
  const dates = sessions.map((s) => s.date);

  const notesByDay: Record<string, ContextNote[]> = {};
  for (const s of sessions) {
    const top = s.topWeight > 0 ? `Top ${s.topWeight} × ${s.topReps}` : `${s.reps} reps`;
    notesByDay[s.date] = [{ text: `${top} · est. 1RM ${s.e1rm} lb · ${s.volume.toLocaleString()} lb volume` }];
  }

  const pos = vals.filter((v): v is number => v != null && v > 0);
  const latest = pos.length ? pos[pos.length - 1] : null;
  const first = pos.length ? pos[0] : null;
  const best = pos.length ? Math.max(...pos) : null;
  const pct = first && latest ? Math.round(((latest - first) / first) * 100) : null;
  const up = pct != null && pct > 0;

  const metricLabel = eff === 'e1rm' ? 'Est. 1RM' : eff === 'volume' ? 'Volume' : 'Reps';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={StyleSheet.absoluteFill} onPress={onClose} activeOpacity={1} />
        <View style={[styles.sheet, { backgroundColor: c.card }]}>
          <SheetHandle color={c.border} />
          <View style={styles.header}>
            <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>{prog.exercise}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}><Text style={[styles.close, { color: c.subtext }]}>✕</Text></TouchableOpacity>
          </View>

          {prog.newPR && (
            <Text style={[styles.pr, { color: c.green }]}>🏆 New PR last session</Text>
          )}

          {weighted && (
            <View style={styles.toggle}>
              {(['e1rm', 'volume'] as const).map((m) => {
                const on = metric === m;
                return (
                  <TouchableOpacity
                    key={m}
                    onPress={() => setMetric(m)}
                    style={[styles.toggleBtn, { borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accentSoft : 'transparent' }]}
                  >
                    <Text style={[styles.toggleTxt, { color: on ? c.accent : c.subtext }]}>{m === 'e1rm' ? 'Est. 1RM' : 'Volume'}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          <LineChart
            series={[{ values: vals, color: c.accent, fill: true }]}
            dates={dates}
            unit={unit}
            formatValue={fmt}
            notesByDay={notesByDay}
            height={110}
          />

          {dates.length > 0 && (
            <View style={styles.dateLabels}>
              <Text style={[styles.dateLabel, { color: c.subtext }]}>{fmtDate(dates[0])}</Text>
              <Text style={[styles.dateLabel, { color: c.subtext }]}>{fmtDate(dates[dates.length - 1])}</Text>
            </View>
          )}

          <View style={[styles.stats, { borderTopColor: c.border }]}>
            <Stat label="LATEST" value={latest != null ? `${fmt(latest)} ${unit}` : '—'} c={c} />
            <View style={[styles.div, { backgroundColor: c.border }]} />
            <Stat label="BEST" value={best != null ? `${fmt(best)} ${unit}` : '—'} c={c} />
            <View style={[styles.div, { backgroundColor: c.border }]} />
            <Stat label="CHANGE" value={pct != null ? `${pct > 0 ? '↑' : pct < 0 ? '↓' : '→'} ${Math.abs(pct)}%` : '—'} valueColor={pct == null ? c.text : up ? c.green : pct < 0 ? c.red : c.subtext} c={c} />
          </View>
          <Text style={[styles.caption, { color: c.subtext }]}>{metricLabel} across your last {prog.n} sessions · scrub to read each</Text>
        </View>
      </View>
    </Modal>
  );
}

function Stat({ label, value, valueColor, c }: { label: string; value: string; valueColor?: string; c: ReturnType<typeof getColors> }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: c.subtext }]}>{label}</Text>
      <Text style={[styles.statValue, { color: valueColor ?? c.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg, paddingBottom: spacing.xl + 10 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  title: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, flex: 1, marginRight: spacing.sm },
  close: { fontSize: 16 },
  pr: { fontSize: 13, fontWeight: '700', marginBottom: spacing.sm },
  toggle: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  toggleBtn: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.xs + 2, alignItems: 'center' },
  toggleTxt: { fontSize: 13, fontWeight: '600' },
  dateLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs, marginBottom: spacing.md },
  dateLabel: { fontSize: 11, fontWeight: '500' },
  stats: { flexDirection: 'row', borderTopWidth: 1, paddingTop: spacing.md },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  div: { width: 1, marginVertical: 4 },
  statLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },
  statValue: { fontSize: 16, fontWeight: '600', letterSpacing: -0.3 },
  caption: { fontSize: 11, textAlign: 'center', fontStyle: 'italic', marginTop: spacing.sm },
});
