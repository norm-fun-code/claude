import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { formatHM } from '../utils/format';
import type { HealthData } from '../hooks/useHealthData';

interface Props {
  health: HealthData;
}

function StatRow({
  label,
  value,
  unit,
  c,
}: {
  label: string;
  value: string | number | null;
  unit?: string;
  c: ReturnType<typeof getColors>;
}) {
  return (
    <View style={styles.statRow}>
      <Text style={[styles.statLabel, { color: c.subtext }]}>{label}</Text>
      <View style={styles.statValueRow}>
        <Text style={[styles.statValue, { color: c.text }]}>
          {value ?? '—'}
        </Text>
        {unit && value !== null && (
          <Text style={[styles.statUnit, { color: c.subtext }]}> {unit}</Text>
        )}
      </View>
    </View>
  );
}

export function HealthCard({ health }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="❤️" title="Health" />

      {/* HRV — primary metric. Baseline-relative grading lives on the Recovery
          card; here we just show the raw reading to avoid a contradictory verdict. */}
      <View style={styles.hrvRow}>
        <View style={styles.hrvLeft}>
          <Text style={[styles.hrvNumber, { color: c.text }]}>
            {health.hrv ?? '—'}
          </Text>
          <Text style={[styles.hrvUnit, { color: c.subtext }]}>ms HRV</Text>
        </View>
      </View>

      <View style={[styles.divider, { backgroundColor: c.border }]} />

      {/* Stats grid */}
      <StatRow label="Resting HR" value={health.restingHR} unit="bpm" c={c} />
      <StatRow
        label="Sleep"
        value={health.sleepHours !== null ? formatHM(health.sleepHours) : null}
        unit={health.sleepQuality ?? undefined}
        c={c}
      />
      {(health.deepSleepHours !== null || health.remSleepHours !== null) && (
        <StatRow
          label="Deep · REM"
          value={`${formatHM(health.deepSleepHours)} · ${formatHM(health.remSleepHours)}`}
          c={c}
        />
      )}
      <StatRow label="Steps" value={health.steps !== null ? health.steps.toLocaleString() : null} c={c} />
      <StatRow label="Active Cal" value={health.activeCalories !== null ? health.activeCalories.toLocaleString() : null} unit="kcal" c={c} />
      {health.vo2Max !== null && (
        <StatRow
          label="VO2 Max"
          value={health.vo2Max}
          unit={`mL/kg/min · ${health.vo2MaxCategory}`}
          c={c}
        />
      )}

      {health.error && (
        <Text style={[styles.errorText, { color: c.subtext }]}>
          HealthKit: {health.error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  hrvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  hrvLeft: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
  },
  hrvNumber: {
    fontSize: 48,
    fontWeight: '300',
    letterSpacing: -2,
  },
  hrvUnit: {
    ...typography.caption,
    fontSize: 14,
  },
  divider: {
    height: 1,
    marginBottom: spacing.md,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs + 2,
  },
  statLabel: {
    ...typography.body,
  },
  statValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  statValue: {
    ...typography.subtitle,
  },
  statUnit: {
    ...typography.caption,
  },
  errorText: {
    ...typography.caption,
    marginTop: spacing.sm,
    fontStyle: 'italic',
  },
});
