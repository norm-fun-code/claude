import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, useColorScheme, TouchableOpacity } from 'react-native';
import { getColors, spacing, radius, typography, colors, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { RecoveryOrb } from './RecoveryOrb';
import { ProgressArc } from './viz/ProgressArc';
import type { Recovery, HealthComposite } from '../hooks/useBriefing';
import { MetricDetailSheet, type MetricConfig } from './MetricDetailSheet';
import { formatHM } from '../utils/format';
import { LineChart } from './viz/LineChart';
import { useSeries } from '../hooks/useSeries';
import { useContextHistory } from '../hooks/useContextHistory';
import { RECOVERY_HISTORY_URL, SOURCES_FRESHNESS_URL, authHeaders, fetchWithTimeout } from '../config';

interface StaleSource { source: string; label: string; ageDays: number }

interface Props {
  recovery: Recovery | null | undefined;
  composites?: HealthComposite[];
  builtAt?: string;
}

const PART_LABEL: Record<string, string> = {
  hrv: 'HRV',
  hrvTrend: 'HRV trend',
  restingHr: 'Resting HR',
  sleep: 'Sleep',
};

const COMPOSITE_EMOJI: Record<string, string> = {
  sleep_debt: '🛌',
  sleep_consistency: '🌙',
  sleep_regularity: '⏰',
  training_load: '🏋️',
};

// Eight Sleep is primary on Recovery card (authoritative overnight source).
// Apple Watch is the secondary overlay so both are visible in one chart.
const RECOVERY_METRICS: Record<string, MetricConfig> = {
  hrv: {
    metric: 'hrv', label: 'HRV', unit: 'ms',
    source: 'eight_sleep', sourceLabel: 'Eight Sleep',
    dualSource: { source: 'apple_health', label: 'Apple Watch', color: '#FF9F0A' },
    formatValue: v => `${Math.round(v)}`,
  },
  resting_hr: {
    metric: 'resting_hr', label: 'Resting HR', unit: 'bpm',
    source: 'eight_sleep', sourceLabel: 'Eight Sleep',
    dualSource: { source: 'apple_health', label: 'Apple Watch', color: '#FF9F0A' },
    formatValue: v => `${Math.round(v)}`,
    lowerIsBetter: true,
  },
};

function formatBuiltAt(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function RecoveryCard({ recovery, composites = [], builtAt }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [selected, setSelected] = useState<MetricConfig | null>(null);
  const trend = useSeries(`${RECOVERY_HISTORY_URL}?days=30`);
  const { contextByDay, notesByDay } = useContextHistory(30);

  // Per-source freshness — stays silent when everything's current; only worth
  // a mention when a source has actually gone stale (2+ days), since that's
  // the one time it affects whether this score can be trusted.
  const [staleSources, setStaleSources] = useState<StaleSource[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(SOURCES_FRESHNESS_URL, { headers: authHeaders() });
        if (cancelled || !res.ok) return;
        const { sources } = await res.json();
        if (!cancelled) setStaleSources((sources ?? []).filter((s: StaleSource) => s.ageDays >= 2));
      } catch { /* offline — stay silent rather than guess */ }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!recovery || recovery.score == null) return null;


  const bandColor =
    recovery.band === 'green' ? colors.green
      : recovery.band === 'yellow' ? colors.yellow
      : recovery.band === 'red' ? colors.red
      : c.subtext;
  const bandLabel =
    recovery.band === 'green' ? 'Recovered'
      : recovery.band === 'yellow' ? 'Moderate'
      : recovery.band === 'red' ? 'Low'
      : 'Recovery';

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="🔋" title="Recovery" />

      <View style={styles.scoreRow}>
        <View style={{ width: 104, height: 104, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ position: 'absolute' }}>
            <ProgressArc score={recovery.score} band={recovery.band} size={104} />
          </View>
          <RecoveryOrb score={recovery.score} band={recovery.band} size={84} />
        </View>
        <View style={styles.scoreMeta}>
          <Text style={[styles.band, { color: bandColor }]}>{bandLabel}</Text>
          {recovery.detail ? (
            <Text style={[styles.detail, { color: c.subtext }]}>{recovery.detail}</Text>
          ) : null}
          {staleSources.length > 0 && (
            <Text style={[styles.staleTxt, { color: staleSources.some((s) => s.ageDays >= 3) ? colors.red : colors.yellow }]}>
              {staleSources.map((s) => `${s.label} ${s.ageDays}d old`).join(' · ')}
            </Text>
          )}
        </View>
      </View>

      {/* 30-day recovery trend — same scorer as the orb, replayed per day */}
      {trend.values.length >= 5 && (
        <View style={[styles.trendBlock, { borderTopColor: c.border }]}>
          <View style={styles.trendHead}>
            <Text style={[styles.trendLabel, { color: c.subtext }]}>30-DAY TREND</Text>
            <Text style={[styles.trendMeta, { color: c.subtext }]}>
              avg {Math.round(trend.values.reduce((a, b) => a + b, 0) / trend.values.length)}
            </Text>
          </View>
          <LineChart
            series={[{ values: trend.values, color: bandColor, fill: true }]}
            dates={trend.rows.map((r) => r.ts.slice(0, 10))}
            height={56}
            formatValue={(v) => `${Math.round(v)} / 100`}
            contextByDay={contextByDay}
            notesByDay={notesByDay}
          />
        </View>
      )}

      {/* Contributing parts (each a percentile of your own baseline) */}
      {Object.keys(recovery.parts || {}).length > 0 && (
        <View style={[styles.parts, { borderTopColor: c.border }]}>
          {Object.entries(recovery.parts).map(([k, v]) => (
            <View key={k} style={styles.part}>
              <View style={styles.partValRow}>
                <Text style={[styles.partVal, { color: c.text }]}>{Math.round(Number(v))}</Text>
                <Text style={[styles.partValUnit, { color: c.subtext }]}>/100</Text>
              </View>
              <Text style={[styles.partLabel, { color: c.subtext }]}>{PART_LABEL[k] ?? k}</Text>
            </View>
          ))}
        </View>
      )}
      {Object.keys(recovery.parts || {}).length > 0 && (
        <Text style={[styles.partsCaption, { color: c.subtext }]}>
          percentile vs your 30-day baseline{formatBuiltAt(builtAt) ? ` · as of ${formatBuiltAt(builtAt)}` : ''}
        </Text>
      )}

      {/* Raw sensor readings — tappable to open trend charts */}
      {(recovery.rawHrv != null || recovery.rawRhr != null) && (
        <View style={[styles.rawRow, { borderTopColor: c.border }]}>
          {recovery.rawHrv != null && (
            <TouchableOpacity onPress={() => setSelected(RECOVERY_METRICS.hrv)} activeOpacity={0.6} style={styles.rawTap}>
              <Text style={[styles.rawItem, { color: c.subtext }]}>
                HRV <Text style={{ color: c.text, fontWeight: '600' }}>{Math.round(recovery.rawHrv)}ms</Text>
                <Text style={{ color: c.border }}> ›</Text>
              </Text>
            </TouchableOpacity>
          )}
          {recovery.rawRhr != null && (
            <TouchableOpacity onPress={() => setSelected(RECOVERY_METRICS.resting_hr)} activeOpacity={0.6} style={styles.rawTap}>
              <Text style={[styles.rawItem, { color: c.subtext }]}>
                RHR <Text style={{ color: c.text, fontWeight: '600' }}>{Math.round(recovery.rawRhr)}bpm</Text>
                <Text style={{ color: c.border }}> ›</Text>
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {(recovery.rawHrv != null || recovery.rawRhr != null) && (
        <Text style={[styles.partsCaption, { color: c.subtext }]}>Overnight · Eight Sleep · tap to see trends</Text>
      )}

      {/* Sleep debt / consistency / training-load flags */}
      {composites.length > 0 && (
        <View style={[styles.flags, { borderTopColor: c.border }]}>
          {composites.map((f) => (
            <View key={f.type} style={styles.flagRow}>
              <Text style={styles.flagEmoji}>{COMPOSITE_EMOJI[f.type] ?? '•'}</Text>
              <View style={styles.flagBody}>
                <Text style={[styles.flagTitle, { color: c.text }]}>{f.title}</Text>
                {f.detail ? (
                  <Text style={[styles.flagDetail, { color: c.subtext }]}>{f.detail}</Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}

      {selected && (
        <MetricDetailSheet
          {...selected}
          visible
          onClose={() => setSelected(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  ring: { width: 88, height: 88, borderRadius: 44, borderWidth: 6, alignItems: 'center', justifyContent: 'center' },
  score: { fontSize: 30, fontWeight: '700', letterSpacing: -1 },
  scoreUnit: { ...typography.caption, fontSize: 11, marginTop: -2 },
  scoreMeta: { flex: 1, gap: spacing.xs },
  band: { ...typography.subtitle, fontSize: 16, fontWeight: '700' },
  detail: { ...typography.caption, fontSize: 13, lineHeight: 18 },
  staleTxt: { ...typography.caption, fontSize: 11, fontWeight: '600', marginTop: 2 },
  parts: { flexDirection: 'row', justifyContent: 'space-around', borderTopWidth: 1, marginTop: spacing.md, paddingTop: spacing.md },
  part: { alignItems: 'center' },
  partValRow: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  partVal: { ...typography.subtitle, fontSize: 20, fontWeight: '600' },
  partValUnit: { ...typography.caption, fontSize: 11 },
  partLabel: { ...typography.caption, fontSize: 11, marginTop: 2 },
  partsCaption: { ...typography.caption, fontSize: 11, textAlign: 'center', marginTop: spacing.xs, fontStyle: 'italic' },
  trendBlock: { borderTopWidth: 1, marginTop: spacing.md, paddingTop: spacing.md },
  trendHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  trendLabel: { ...typography.label, fontSize: 10 },
  trendMeta: { ...typography.caption, fontSize: 11 },
  rawRow: { flexDirection: 'row', gap: spacing.lg, justifyContent: 'center', borderTopWidth: 1, marginTop: spacing.sm, paddingTop: spacing.sm },
  rawTap: { paddingVertical: 2, paddingHorizontal: 4 },
  rawItem: { fontSize: 12 },
  flags: { borderTopWidth: 1, marginTop: spacing.md, paddingTop: spacing.sm, gap: spacing.sm },
  flagRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  flagEmoji: { fontSize: 16, marginTop: 1 },
  flagBody: { flex: 1 },
  flagTitle: { ...typography.body, fontWeight: '600', fontSize: 14 },
  flagDetail: { ...typography.caption, fontSize: 12, lineHeight: 17, marginTop: 1 },
});
