import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, useColorScheme } from 'react-native';
import { SectionHeader } from './SectionHeader';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { EXPERIMENTS_URL, authHeaders } from '../config';

const METRIC_LABELS: Record<string, string> = {
  'health:hrv':         'HRV',
  'health:sleep_hours': 'Sleep duration',
  'health:sleep_score': 'Sleep score',
  'health:resting_hr':  'Resting HR',
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
  paused_at: string | null;
};

// `now` is the real clock, UNLESS the experiment is paused — pausing is
// supposed to freeze the clock (the backend only extends end_date at RESUME,
// by however long it was paused), so day-elapsed/days-left must freeze at
// paused_at too. Computing straight off Date.now() while paused made the
// display keep advancing every day even though nothing was actually running.
function daysLeft(endDate: string | null, now: number): number | null {
  if (!endDate) return null;
  const diff = new Date(endDate).getTime() - now;
  return Math.max(0, Math.ceil(diff / 86400000));
}

function daysElapsed(startDate: string | null, now: number): number {
  if (!startDate) return 0;
  return Math.max(0, Math.floor((now - new Date(startDate).getTime()) / 86400000));
}

function totalDays(startDate: string | null, endDate: string | null): number | null {
  if (!startDate || !endDate) return null;
  return Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ExperimentsCard() {
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

  const dismiss = useCallback(async (id: number) => {
    setExperiments((prev) => prev.filter((e) => e.id !== id));
    try {
      await fetch(`${EXPERIMENTS_URL}/${id}`, { method: 'DELETE', headers: authHeaders() });
    } catch { /* optimistic — silently ignore */ }
  }, []);

  const startExperiment = useCallback(async (id: number) => {
    setExperiments((prev) =>
      prev.map((e) => e.id === id ? { ...e, status: 'running', start_date: new Date().toISOString() } : e)
    );
    try {
      await fetch(`${EXPERIMENTS_URL}/${id}/start`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ testDays: 14 }),
      });
      fetch_();
    } catch {
      fetch_();
    }
  }, [fetch_]);

  const togglePause = useCallback(async (exp: Experiment) => {
    const action = exp.status === 'paused' ? 'resume' : 'pause';
    // Optimistic update
    setExperiments((prev) =>
      prev.map((e) =>
        e.id === exp.id
          ? { ...e, status: action === 'pause' ? 'paused' : 'running', paused_at: action === 'pause' ? new Date().toISOString() : null }
          : e
      )
    );
    try {
      await fetch(`${EXPERIMENTS_URL}/${exp.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      // Refresh to get updated end_date after resume
      if (action === 'resume') fetch_();
    } catch {
      fetch_(); // rollback on error
    }
  }, [fetch_]);

  useEffect(() => { fetch_(); }, [fetch_]);

  const proposed = experiments.filter((e) => e.status === 'proposed');
  const active = experiments.filter((e) => e.status === 'running' || e.status === 'paused');
  const completed = experiments.filter((e) => e.status === 'completed' || e.status === 'cancelled');
  const visible = showAll ? [...proposed, ...active, ...completed] : [...proposed, ...active];

  if (loading) {
    return (
      <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
        <SectionHeader emoji="🧪" title="Experiments" tint="violet" />
        <ActivityIndicator color={c.accent} style={{ marginTop: spacing.sm }} />
      </View>
    );
  }

  if (experiments.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="🧪" title="Experiments" tint="violet" />

      {visible.map((exp) => {
        const effectiveNow = exp.status === 'paused' && exp.paused_at ? new Date(exp.paused_at).getTime() : Date.now();
        const elapsed = daysElapsed(exp.start_date, effectiveNow);
        const total = totalDays(exp.start_date, exp.end_date);
        const left = daysLeft(exp.end_date, effectiveNow);
        const progress = total && total > 0 ? Math.min(1, elapsed / total) : 0;
        const isProposed = exp.status === 'proposed';
        const isRunning = exp.status === 'running';
        const isPaused = exp.status === 'paused';
        const isActive = isRunning || isPaused;
        const metricLabel = METRIC_LABELS[exp.metric] ?? exp.metric;

        return (
          <View key={exp.id} style={[styles.row, { borderTopColor: c.border }]}>
            <View style={styles.rowTop}>
              <Text style={[styles.hypothesis, { color: c.text }]} numberOfLines={2}>
                {exp.hypothesis}
              </Text>
              <View style={styles.rowRight}>
                {isProposed && (
                  <View style={[styles.badge, { backgroundColor: isDark ? 'rgba(255,159,10,0.22)' : '#FFF3E0' }]}>
                    <Text style={[styles.badgeText, { color: isDark ? '#FFB84D' : '#E65100' }]}>Proposed</Text>
                  </View>
                )}
                {isRunning && (
                  <View style={[styles.badge, { backgroundColor: c.accentSoft }]}>
                    <Text style={[styles.badgeText, { color: c.accent }]}>Active</Text>
                  </View>
                )}
                {isPaused && (
                  <View style={[styles.badge, { backgroundColor: c.border }]}>
                    <Text style={[styles.badgeText, { color: c.subtext }]}>Paused</Text>
                  </View>
                )}
                {!isActive && !isProposed && (
                  <View style={[styles.badge, { backgroundColor: c.border }]}>
                    <Text style={[styles.badgeText, { color: c.subtext }]}>
                      {exp.status === 'completed' ? 'Done' : 'Cancelled'}
                    </Text>
                  </View>
                )}
                <TouchableOpacity onPress={() => dismiss(exp.id)} hitSlop={10}>
                  <Text style={[styles.dismiss, { color: c.subtext }]}>×</Text>
                </TouchableOpacity>
              </View>
            </View>

            <Text style={[styles.meta, { color: c.subtext }]}>
              Tracking: {metricLabel}
            </Text>

            {isProposed && exp.protocol && (
              <Text style={[styles.protocol, { color: c.subtext }]} numberOfLines={3}>
                {exp.protocol}
              </Text>
            )}

            {isProposed && (
              <TouchableOpacity onPress={() => startExperiment(exp.id)} hitSlop={8} style={styles.startBtn}>
                <Text style={[styles.startText, { color: c.accent }]}>Start 14-day experiment →</Text>
              </TouchableOpacity>
            )}

            {isActive && total !== null && (
              <>
                <View style={[styles.track, { backgroundColor: c.border }]}>
                  <View style={[styles.fill, { backgroundColor: isPaused ? c.subtext : c.accent, width: `${Math.round(progress * 100)}%` as any }]} />
                </View>
                <Text style={[styles.meta, { color: c.subtext }]}>
                  Day {elapsed + 1} / {total}{left !== null && left > 0 ? `  ·  ${left}d left` : ''}
                  {exp.end_date ? `  ·  ends ${fmtDate(exp.end_date)}` : ''}
                </Text>
              </>
            )}

            {exp.verdict && (
              <Text style={[styles.verdict, { color: c.text }]}>{exp.verdict}</Text>
            )}

            {exp.protocol && isActive && (
              <Text style={[styles.protocol, { color: c.subtext }]} numberOfLines={2}>
                {exp.protocol}
              </Text>
            )}

            {isActive && (
              <TouchableOpacity onPress={() => togglePause(exp)} hitSlop={8} style={styles.pauseBtn}>
                <Text style={[styles.pauseText, { color: c.accent }]}>
                  {isPaused ? 'Resume experiment' : 'Pause experiment'}
                </Text>
              </TouchableOpacity>
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
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 0 },
  dismiss: { fontSize: 20, lineHeight: 20, fontWeight: '300' },
  hypothesis: { fontSize: 14, fontWeight: '600', lineHeight: 20, flex: 1 },
  badge: { borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  badgeText: { fontSize: 11, fontWeight: '700' },
  meta: { fontSize: 12, lineHeight: 17 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 2 },
  fill: { height: 4, borderRadius: 2 },
  verdict: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  protocol: { fontSize: 12, lineHeight: 17, fontStyle: 'italic' },
  pauseBtn: { alignSelf: 'flex-start', marginTop: 2 },
  pauseText: { fontSize: 12, fontWeight: '600' },
  startBtn: { alignSelf: 'flex-start', marginTop: spacing.xs },
  startText: { fontSize: 13, fontWeight: '700' },
  toggle: { marginTop: spacing.md, alignItems: 'center' },
  toggleText: { fontSize: 13, fontWeight: '600' },
});

const ExperimentsCardMemo = React.memo(ExperimentsCard);
export { ExperimentsCardMemo as ExperimentsCard };
