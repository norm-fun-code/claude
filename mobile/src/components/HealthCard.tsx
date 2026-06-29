import React, { useState } from 'react';
import { View, Text, StyleSheet, useColorScheme, TouchableOpacity } from 'react-native';
import { getColors, spacing, radius, typography, shadow, colors } from '../theme';
import { SectionHeader } from './SectionHeader';
import { formatHM } from '../utils/format';
import type { HealthData } from '../hooks/useHealthData';
import { MetricDetailSheet, type MetricConfig } from './MetricDetailSheet';
import { MiniBars } from './viz/MiniBars';
import { Trend } from './viz/Trend';
import { useSeries } from '../hooks/useSeries';
import { METRICS_HISTORY_URL } from '../config';

interface Props {
  health: HealthData;
}

// A 14-day trend for one metric, fetched on demand. Continuous signals (HRV, RHR)
// render as a Skia line; discrete amounts (steps, active energy, sleep) as bars.
// `cumulative` metrics (steps, active energy) build through the day, so today's
// running partial is dropped — otherwise an early-in-the-day total renders as a
// misleading cliff next to the full prior days.
function RowSpark({ metric, source, color, height = 22, width, cumulative, line }: {
  metric: string; source?: string; color: string; height?: number; width?: number; cumulative?: boolean; line?: boolean;
}) {
  const url = `${METRICS_HISTORY_URL}?metric=${metric}&days=14${source ? `&source=${source}` : ''}`;
  const { rows } = useSeries(url);
  let pts = rows;
  if (cumulative && pts.length) {
    const todayLocal = new Date().toLocaleDateString('en-CA');
    const lastDay = new Date(pts[pts.length - 1].ts).toLocaleDateString('en-CA');
    if (lastDay === todayLocal) pts = pts.slice(0, -1);
  }
  const values = pts.map((p) => p.value);
  if (values.length < 3) return null;
  return (
    <View style={width ? { width } : undefined}>
      {line
        ? <Trend values={values} height={height} color={color} max={14} />
        : <MiniBars values={values} height={height} color={color} max={14} gap={1.5} />}
    </View>
  );
}

function vo2Color(category: string | null): string {
  if (!category) return colors.subtext;
  if (category === 'Very High' || category === 'High' || category === 'Above Average') return colors.green;
  if (category === 'Average') return colors.yellow;
  return colors.red;
}

function StatRow({
  label, value, unit, subtitle, subtitleColor, onPress, c, spark,
}: {
  label: string;
  value: string | number | null;
  unit?: string;
  subtitle?: string;
  subtitleColor?: string;
  onPress?: () => void;
  c: ReturnType<typeof getColors>;
  spark?: React.ReactNode;
}) {
  const inner = (
    <View style={styles.statRow}>
      <Text style={[styles.statLabel, { color: c.subtext }]}>{label}</Text>
      {spark ? <View style={styles.statSpark}>{spark}</View> : null}
      <View style={styles.statRight}>
        <View style={styles.statValueRow}>
          <Text style={[styles.statValue, { color: c.text }]}>{value ?? '—'}</Text>
          {unit && value !== null && (
            <Text style={[styles.statUnit, { color: c.subtext }]}> {unit}</Text>
          )}
        </View>
        {subtitle && value !== null && (
          <Text style={[styles.statSubtitle, { color: subtitleColor ?? c.subtext }]}>{subtitle}</Text>
        )}
      </View>
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.6}>
        {inner}
      </TouchableOpacity>
    );
  }
  return inner;
}

const METRICS: Record<string, MetricConfig> = {
  // HRV and RHR: Apple Watch is primary (live intraday, shown on this card).
  // Eight Sleep is overlaid as secondary so you can compare overnight vs daytime.
  hrv: {
    metric: 'hrv', label: 'HRV', unit: 'ms',
    source: 'apple_health', sourceLabel: 'Apple Watch',
    dualSource: { source: 'eight_sleep', label: 'Eight Sleep', color: '#FF9F0A' },
    formatValue: v => `${Math.round(v)}`,
  },
  resting_hr: {
    metric: 'resting_hr', label: 'Resting HR', unit: 'bpm',
    source: 'apple_health', sourceLabel: 'Apple Watch',
    dualSource: { source: 'eight_sleep', label: 'Eight Sleep', color: '#FF9F0A' },
    formatValue: v => `${Math.round(v)}`,
    lowerIsBetter: true,
  },
  sleep_hours: {
    metric: 'sleep_hours', label: 'Sleep', unit: 'hours', source: 'eight_sleep',
    formatValue: v => formatHM(v),
  },
  // Activity metrics: Apple Health is the only source.
  steps: {
    metric: 'steps', label: 'Steps', unit: 'steps', source: 'apple_health',
    formatValue: v => Math.round(v).toLocaleString(),
  },
  active_energy: {
    metric: 'active_energy', label: 'Active Cal', unit: 'kcal', source: 'apple_health',
    formatValue: v => Math.round(v).toLocaleString(),
  },
  vo2_max: {
    metric: 'vo2_max', label: 'VO2 Max', unit: 'mL/kg/min', source: 'apple_health',
    formatValue: v => `${Math.round(v * 10) / 10}`,
  },
};

export function HealthCard({ health }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [selected, setSelected] = useState<MetricConfig | null>(null);

  const open = (key: string) => setSelected(METRICS[key]);

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="❤️" title="Health" />

      {/* HRV hero — tappable to open trend sheet, with a 14-day trend alongside */}
      <TouchableOpacity onPress={() => open('hrv')} activeOpacity={0.6} style={styles.hrvRow}>
        <View style={styles.hrvLeft}>
          <Text style={[styles.hrvNumber, { color: c.text }]}>
            {health.hrv ?? '—'}
          </Text>
          <Text style={[styles.hrvUnit, { color: c.subtext }]}>ms HRV</Text>
        </View>
        <View style={styles.hrvSpark}>
          <RowSpark metric="hrv" source="apple_health" color={c.accent} height={34} width={130} line />
        </View>
        <Text style={[styles.hrvChevron, { color: c.border }]}>›</Text>
      </TouchableOpacity>

      <View style={[styles.divider, { backgroundColor: c.border }]} />

      {health.vo2Max !== null && (
        <>
          <TouchableOpacity onPress={() => open('vo2_max')} activeOpacity={0.6} style={styles.vo2Row}>
            <View style={styles.vo2Left}>
              <Text style={[styles.vo2Number, { color: vo2Color(health.vo2MaxCategory) }]}>
                {health.vo2Max}
              </Text>
              <Text style={[styles.vo2Unit, { color: c.subtext }]}>mL/kg/min VO2</Text>
            </View>
            {health.vo2MaxCategory && (
              <View style={[styles.vo2Badge, { backgroundColor: vo2Color(health.vo2MaxCategory) + '22', borderColor: vo2Color(health.vo2MaxCategory) + '55' }]}>
                <Text style={[styles.vo2BadgeText, { color: vo2Color(health.vo2MaxCategory) }]}>{health.vo2MaxCategory}</Text>
              </View>
            )}
          </TouchableOpacity>
          <View style={[styles.divider, { backgroundColor: c.border }]} />
        </>
      )}

      <StatRow
        label="Resting HR" value={health.restingHR} unit="bpm"
        onPress={() => open('resting_hr')} c={c}
        spark={<RowSpark metric="resting_hr" source="apple_health" color={c.accent} width={64} height={26} line />}
      />
      <StatRow
        label="Sleep"
        value={health.sleepHours !== null ? formatHM(health.sleepHours) : null}
        unit={health.sleepQuality ?? undefined}
        onPress={() => open('sleep_hours')} c={c}
        spark={<RowSpark metric="sleep_hours" source="eight_sleep" color={c.accent} width={64} />}
      />
      {(health.deepSleepHours !== null || health.remSleepHours !== null) && (
        <StatRow
          label="Deep · REM"
          value={`${formatHM(health.deepSleepHours)} · ${formatHM(health.remSleepHours)}`}
          c={c}
        />
      )}
      <StatRow
        label="Steps"
        value={health.steps !== null ? health.steps.toLocaleString() : null}
        onPress={() => open('steps')} c={c}
        spark={<RowSpark metric="steps" source="apple_health" color={c.accent} width={64} cumulative />}
      />
      <StatRow
        label="Active Cal"
        value={health.activeCalories !== null ? health.activeCalories.toLocaleString() : null}
        unit="kcal"
        onPress={() => open('active_energy')} c={c}
        spark={<RowSpark metric="active_energy" source="apple_health" color={c.accent} width={64} cumulative />}
      />

      {health.error && (
        <Text style={[styles.errorText, { color: c.subtext }]}>
          HealthKit: {health.error}
        </Text>
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
  hrvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  hrvLeft: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs },
  hrvNumber: { fontSize: 48, fontWeight: '300', letterSpacing: -2 },
  hrvUnit: { ...typography.caption, fontSize: 14 },
  hrvSpark: { flex: 1, alignItems: 'flex-end', justifyContent: 'flex-end', marginHorizontal: spacing.md, paddingBottom: 8 },
  hrvChevron: { fontSize: 22, fontWeight: '300' },
  divider: { height: 1, marginBottom: spacing.md },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs + 2,
  },
  statLabel: { ...typography.body },
  statSpark: { flex: 1, alignItems: 'flex-end', justifyContent: 'center', marginHorizontal: spacing.md },
  statRight: { alignItems: 'flex-end', minWidth: 56 },
  statValueRow: { flexDirection: 'row', alignItems: 'baseline' },
  statValue: { ...typography.subtitle },
  statUnit: { ...typography.caption },
  statSubtitle: { fontSize: 11, fontWeight: '500', marginTop: 1 },
  errorText: { ...typography.caption, marginTop: spacing.sm, fontStyle: 'italic' },
  vo2Row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  vo2Left: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs },
  vo2Number: { fontSize: 32, fontWeight: '300', letterSpacing: -1 },
  vo2Unit: { ...typography.caption, fontSize: 13 },
  vo2Badge: { borderRadius: radius.sm, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  vo2BadgeText: { fontSize: 11, fontWeight: '700' },
});
