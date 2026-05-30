import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import { Insight } from '../hooks/useBriefing';

interface Action {
  title: string;
  detail: string | null;
}

interface Props {
  actions: Action[];
  insights: Insight[];
}

// The front page: what to do now, then why (supporting findings).
export function LeverageCard({ actions, insights }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if ((!actions || actions.length === 0) && (!insights || insights.length === 0)) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="🎯" title="Highest Leverage Now" />

      {actions.map((a, i) => (
        <View key={`a${i}`} style={styles.action}>
          <View style={[styles.rank, { backgroundColor: c.accent }]}>
            <Text style={[styles.rankText, { color: '#FFFFFF' }]}>{i + 1}</Text>
          </View>
          <View style={styles.actionBody}>
            <Text style={[styles.actionTitle, { color: c.text }]}>{a.title}</Text>
            {a.detail ? (
              <Text style={[styles.actionDetail, { color: c.subtext }]}>{a.detail}</Text>
            ) : null}
          </View>
        </View>
      ))}

      {insights && insights.length > 0 && (
        <View style={[styles.insights, { borderColor: c.border }]}>
          <Text style={[styles.insightsLabel, { color: c.subtext }]}>WHAT THE DATA SHOWS</Text>
          {insights.map((ins, i) => (
            <View key={`i${i}`} style={styles.bulletRow}>
              <Text style={[styles.dot, { color: c.subtext }]}>•</Text>
              <Text style={[styles.bulletText, { color: c.subtext }]}>{ins.title}</Text>
            </View>
          ))}
        </View>
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
  action: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    alignItems: 'flex-start',
  },
  rank: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  rankText: {
    fontSize: 13,
    fontWeight: '700',
  },
  actionBody: { flex: 1 },
  actionTitle: {
    ...typography.subtitle,
    marginBottom: 2,
  },
  actionDetail: {
    ...typography.body,
    fontSize: 13,
  },
  insights: {
    borderTopWidth: 1,
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
  },
  insightsLabel: {
    ...typography.label,
    fontSize: 10,
    marginBottom: spacing.xs,
  },
  bulletRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xs },
  dot: { fontSize: 14 },
  bulletText: { ...typography.body, fontSize: 13, flex: 1 },
});
