import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { EXPERIMENTS_URL, authHeaders } from '../config';

const METRIC_LABELS: Record<string, string> = {
  'health:hrv':         'HRV',
  'health:sleep_hours': 'Sleep duration',
  'health:sleep_score': 'Sleep score',
  'health:resting_hr':  'Resting HR',
  'habits:cold_shower': 'Cold shower',
  'habits:exercise':    'Exercise',
  'habits:eat_healthy': 'Eating healthy',
  'wellbeing:mood':     'Mood',
  'wellbeing:energy':   'Energy',
  'wellbeing:focus':    'Focus',
};

type Experiment = {
  id: number;
  hypothesis: string;
  metric: string;
  lever: string | null;
  expected: string;
  protocol: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  verdict: string | null;
};

function daysLeft(endDate: string | null): number | null {
  if (!endDate) return null;
  const diff = new Date(endDate).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86400000));
}

function daysElapsed(startDate: string | null): number {
  if (!startDate) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(startDate).getTime()) / 86400000));
}

function totalDays(startDate: string | null, endDate: string | null): number | null {
  if (!startDate || !endDate) return null;
  return Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ExperimentsCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(EXPERIMENTS_URL, { headers: authHeaders() });
      if (!res.ok) return;
      const { experiments: rows } = await res.json();
      setExperiments(rows ?? []);
    } catch { /* best effort */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch_(); }, [fetch_]);

  const running = experiments.filter((e) => e.status === 'running');
  const completed = experiments.filter((e) => e.status === 'completed' || e.status === 'cancelled');
  const visible = showAll ? [...running, ...completed] : running;

  if (loading) {
    return (
      <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
        <Text style={[styles.label, { color: c.subtext }]}>EXPERIMENTS</Text>
        <ActivityIndicator color={c.accent} style={{ marginTop: spacing.sm }} />
      </View>
    );
  }

  if (experiments.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <Text style={[styles.label, { color: c.subtext }]}>EXPERIMENTS</Text>

      {visible.map((exp) => {
        const elapsed = daysElapsed(exp.start_date);
        const total = totalDays(exp.start_date, exp.end_date);
        const left = daysLeft(exp.end_date);
        const progress = total && total > 0 ? Math.min(1, elapsed / total) : 0;
        const isRunning = exp.status === 'running';
        const metricLabel = METRIC_LABELS[exp.metric] ?? exp.metric;

        return (
          <View key={exp.id} style={[styles.row, { borderTopColor: c.border }]}>
            <View style={styles.rowTop}>
              <Text style={[styles.hypothesis, { color: c.text }]} numberOfLines={2}>
                {exp.hypothesis}
              </Text>
              {isRunning ? (
                <View style={[styles.badge, { backgroundColor: c.accentSoft }]}>
                  <Text style={[styles.badgeText, { color: c.accent }]}>Active</Text>
                </View>
              ) : (
                <View style={[styles.badge, { backgroundColor: c.border }]}>
                  <Text style={[styles.badgeText, { color: c.subtext }]}>
                    {exp.status === 'completed' ? 'Done' : 'Cancelled'}
                  </Text>
                </View>
              )}
            </View>

            <Text style={[styles.meta, { color: c.subtext }]}>
              Tracking: {metricLabel}
            </Text>

            {isRunning && total !== null && (
              <>
                <View style={[styles.track, { backgroundColor: c.border }]}>
                  <View style={[styles.fill, { backgroundColor: c.accent, width: `${Math.round(progress * 100)}%` as any }]} />
                </View>
                <Text style={[styles.meta, { color: c.subtext }]}>
                  {elapsed} / {total} days{left !== null && left > 0 ? `  ·  ${left}d left` : ''}
                  {exp.end_date ? `  ·  ends ${fmtDate(exp.end_date)}` : ''}
                </Text>
              </>
            )}

            {exp.verdict && (
              <Text style={[styles.verdict, { color: c.text }]}>{exp.verdict}</Text>
            )}

            {exp.protocol && isRunning && (
              <Text style={[styles.protocol, { color: c.subtext }]} numberOfLines={2}>
                {exp.protocol}
              </Text>
            )}
          </View>
        );
      })}

      {completed.length > 0 && (
        <TouchableOpacity onPress={() => setShowAll((v) => !v)} hitSlop={8} style={styles.toggle}>
          <Text style={[styles.toggleText, { color: c.accent }]}>
            {showAll ? 'Hide past experiments' : `Show ${completed.length} past experiment${completed.length === 1 ? '' : 's'}`}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  label: { ...typography.label, fontSize: 10, letterSpacing: 1, marginBottom: spacing.sm },
  row: { paddingTop: spacing.md, marginTop: spacing.sm, borderTopWidth: 1, gap: 6 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  hypothesis: { fontSize: 14, fontWeight: '600', lineHeight: 20, flex: 1 },
  badge: { borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  badgeText: { fontSize: 11, fontWeight: '700' },
  meta: { fontSize: 12, lineHeight: 17 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 2 },
  fill: { height: 4, borderRadius: 2 },
  verdict: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  protocol: { fontSize: 12, lineHeight: 17, fontStyle: 'italic' },
  toggle: { marginTop: spacing.md, alignItems: 'center' },
  toggleText: { fontSize: 13, fontWeight: '600' },
});
