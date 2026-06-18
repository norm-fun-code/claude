import React, { useState } from 'react';
import { View, Text, StyleSheet, useColorScheme, TouchableOpacity } from 'react-native';
import { getColors, spacing, radius, typography, shadow, colors } from '../theme';
import { SectionHeader } from './SectionHeader';
import { formatHM } from '../utils/format';
import type { HealthData } from '../hooks/useHealthData';
import { MetricDetailSheet, type MetricConfig } from './MetricDetailSheet';

interface Props {
  health: HealthData;
}

function vo2Color(category: string | null): string {
  if (!category) return colors.subtext;
  if (category === 'Very High' || category === 'High' || category === 'Above Average') return colors.green;
  if (category === 'Average') return colors.yellow;
  return colors.red;
}

function StatRow({
  label, value, unit, subtitle, subtitleColor, onPress, c,
}: {
  label: string;
  value: string | number | null;
  unit?: string;
  subtitle?: string;
  subtitleColor?: string;
  onPress?: () => void;
  c: ReturnType<typeof getColors>;
}) {
  const inner = (
    <View style={styles.statRow}>
      <Text style={[styles.statLabel, { color: c.subtext }]}>{label}</Text>
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
  hrv: {
    metric: 'hrv', label: 'HRV', unit: 'ms',
    formatValue: v => `${Math.round(v)}`,
  },
  resting_hr: {
    metric: 'resting_hr', label: 'Resting HR', unit: 'bpm',
    formatValue: v => `${Math.round(v)}`,
    lowerIsBetter: true,
  },
  sleep_hours: {
    metric: 'sleep_hours', label: 'Sleep', unit: 'hours',
    formatValue: v => formatHM(v),
  },
  steps: {
    metric: 'steps', label: 'Steps', unit: 'steps',
    formatValue: v => Math.round(v).toLocaleString(),
  },
  active_energy: {
    metric: 'active_energy', label: 'Active Cal', unit: 'kcal',
    formatValue: v => Math.round(v).toLocaleString(),
  },
  vo2_max: {
    metric: 'vo2_max', label: 'VO2 Max', unit: 'mL/kg/min',
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

      {/* HRV hero — tappable to open trend sheet */}
      <TouchableOpacity onPress={() => open('hrv')} activeOpacity={0.6} style={styles.hrvRow}>
        <View style={styles.hrvLeft}>
          <Text style={[styles.hrvNumber, { color: c.text }]}>
            {health.hrv ?? '—'}
          </Text>
          <Text style={[styles.hrvUnit, { color: c.subtext }]}>ms HRV</Text>
        </View>
        <Text style={[styles.hrvChevron, { color: c.border }]}>›</Text>
      </TouchableOpacity>

      <View style={[styles.divider, { backgroundColor: c.border }]} />

      <StatRow
        label="Resting HR" value={health.restingHR} unit="bpm"
        onPress={() => open('resting_hr')} c={c}
      />
      <StatRow
        label="Sleep"
        value={health.sleepHours !== null ? formatHM(health.sleepHours) : null}
        unit={health.sleepQuality ?? undefined}
        onPress={() => open('sleep_hours')} c={c}
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
      />
      <StatRow
        label="Active Cal"
        value={health.activeCalories !== null ? health.activeCalories.toLocaleString() : null}
        unit="kcal"
        onPress={() => open('active_energy')} c={c}
      />
      {health.vo2Max !== null && (
        <StatRow
          label="VO2 Max"
          value={health.vo2Max}
          subtitle={health.vo2MaxCategory ?? undefined}
          subtitleColor={vo2Color(health.vo2MaxCategory)}
          onPress={() => open('vo2_max')} c={c}
        />
      )}

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
  hrvChevron: { fontSize: 22, fontWeight: '300' },
  divider: { height: 1, marginBottom: spacing.md },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs + 2,
  },
  statLabel: { ...typography.body },
  statRight: { alignItems: 'flex-end' },
  statValueRow: { flexDirection: 'row', alignItems: 'baseline' },
  statValue: { ...typography.subtitle },
  statUnit: { ...typography.caption },
  statSubtitle: { fontSize: 11, fontWeight: '500', marginTop: 1 },
  errorText: { ...typography.caption, marginTop: spacing.sm, fontStyle: 'italic' },
});
