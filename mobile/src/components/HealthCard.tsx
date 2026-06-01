import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, colors } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { HealthData, HRVStatus } from '../hooks/useHealthData';

interface Props {
  health: HealthData;
}

function HRVDot({ status }: { status: HRVStatus }) {
  const dotColor =
    status === 'green' ? colors.green : status === 'yellow' ? colors.yellow : status === 'red' ? colors.red : '#AAAAAA';

  return (
    <View
      style={[
        styles.dot,
        { backgroundColor: dotColor, shadowColor: dotColor },
      ]}
    />
  );
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

  const hrvLabel =
    health.hrvStatus === 'green'
      ? 'High — train as planned'
      : health.hrvStatus === 'yellow'
      ? 'Moderate — consider downgrade'
      : health.hrvStatus === 'red'
      ? 'Low — mobility/walk only'
      : 'No data';

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="❤️" title="Health" />

      {/* HRV — primary metric */}
      <View style={styles.hrvRow}>
        <View style={styles.hrvLeft}>
          <Text style={[styles.hrvNumber, { color: c.text }]}>
            {health.hrv ?? '—'}
          </Text>
          <Text style={[styles.hrvUnit, { color: c.subtext }]}>ms HRV</Text>
        </View>
        <View style={styles.hrvRight}>
          <HRVDot status={health.hrvStatus} />
          <Text style={[styles.hrvLabel, { color: c.subtext }]}>{hrvLabel}</Text>
        </View>
      </View>

      <View style={[styles.divider, { backgroundColor: c.border }]} />

      {/* Stats grid */}
      <StatRow label="Resting HR" value={health.restingHR} unit="bpm" c={c} />
      <StatRow
        label="Sleep score"
        value={health.sleepScore}
        unit={health.sleepScore !== null ? '/ 100' : undefined}
        c={c}
      />
      <StatRow
        label="Sleep"
        value={health.sleepHours !== null ? `${health.sleepHours} hrs` : null}
        unit={health.sleepQuality ?? undefined}
        c={c}
      />
      {(health.deepSleepHours !== null || health.remSleepHours !== null) && (
        <StatRow
          label="Deep · REM"
          value={
            `${health.deepSleepHours ?? '—'} · ${health.remSleepHours ?? '—'}`
          }
          unit="hrs"
          c={c}
        />
      )}
      <StatRow label="Steps" value={health.steps !== null ? health.steps.toLocaleString() : null} c={c} />
      <StatRow label="Active Cal" value={health.activeCalories !== null ? health.activeCalories.toLocaleString() : null} unit="kcal" c={c} />

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
    borderWidth: 1,
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
  hrvRight: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    shadowOpacity: 0.6,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 4,
    elevation: 2,
  },
  hrvLabel: {
    ...typography.caption,
    textAlign: 'right',
    maxWidth: 180,
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
