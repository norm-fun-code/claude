import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import { Forecast } from '../hooks/useBriefing';

interface Props {
  forecasts: Forecast[];
}

// Color + label for a forecast's status. Green = on track, amber = at risk,
// red = off track. Neutral for "on pace / stalled / not enough data".
function statusStyle(status: string | null, probability: number | null) {
  switch (status) {
    case 'on_track':
      return { dot: '#2E7D32', label: 'On track' };
    case 'at_risk':
      return { dot: '#E8A33D', label: 'At risk' };
    case 'off_track':
      return { dot: '#C0392B', label: 'Off track' };
    case 'on_pace':
      return { dot: '#2E7D32', label: 'On pace' };
    case 'stalled':
      return { dot: '#C0392B', label: 'Stalled' };
    case 'insufficient_data':
      return { dot: '#9E9E9E', label: 'Gathering data' };
    default:
      return { dot: '#9E9E9E', label: probability != null ? `${Math.round(probability * 100)}%` : '—' };
  }
}

export function ForecastCard({ forecasts }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!forecasts || forecasts.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="📈" title="Goal Forecasts" />

      {forecasts.map((f, i) => {
        const s = statusStyle(f.status, f.probability);
        const pctLabel = f.probability != null ? `${Math.round(f.probability * 100)}%` : null;
        return (
          <View key={i} style={[styles.row, i > 0 && { borderTopColor: c.border, borderTopWidth: 1 }]}>
            <View style={[styles.dot, { backgroundColor: s.dot }]} />
            <View style={styles.body}>
              <Text style={[styles.title, { color: c.text }]}>{f.title}</Text>
              {f.detail ? (
                <Text style={[styles.detail, { color: c.subtext }]}>{f.detail}</Text>
              ) : null}
              <View style={styles.metaRow}>
                <Text style={[styles.statusLabel, { color: s.dot }]}>{s.label}</Text>
                {pctLabel && f.status !== 'insufficient_data' ? (
                  <Text style={[styles.prob, { color: c.subtext }]}>· {pctLabel} likely</Text>
                ) : null}
              </View>
            </View>
          </View>
        );
      })}
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
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
    alignItems: 'flex-start',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 5,
  },
  body: { flex: 1 },
  title: {
    ...typography.subtitle,
    fontSize: 15,
    marginBottom: 2,
  },
  detail: {
    ...typography.body,
    fontSize: 13,
    marginBottom: 4,
  },
  metaRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'center',
  },
  statusLabel: {
    ...typography.label,
    fontSize: 12,
    fontWeight: '700',
  },
  prob: {
    ...typography.caption,
    fontSize: 12,
  },
});
