import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { HealthData } from '../hooks/useHealthData';
import type { BriefingData, Recovery } from '../hooks/useBriefing';
import { scoreToBand } from '../hooks/useRecovery';

interface Props {
  briefing: BriefingData | null;
  health: HealthData;
  recovery?: Recovery | null;
}

export function WeeklyStateCard({ briefing, health, recovery }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const goals = briefing?.weeklyGoals?.current?.goals ?? [];
  const goalsHit = goals.filter(g => g.achieved).length;
  const goalsTotal = goals.length;

  const hrv = health.hrv;
  // Color the HRV tile by how today's HRV ranks against the user's OWN baseline
  // (the Recovery card's HRV sub-score), not an absolute 50ms cutoff — so a
  // 50ms reading that's low FOR YOU shows yellow here too, not green.
  const hrvBand = scoreToBand(recovery?.parts?.hrv);

  const hrvColor =
    hrvBand === 'green' ? '#1D9E75' :
    hrvBand === 'yellow' ? '#BA7517' :
    hrvBand === 'red' ? '#993C1D' : c.subtext;

  const topInsight = briefing?.healthInsights?.[0];

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="📊" title="This Week" />
      <View style={styles.grid}>
        <View style={[styles.tile, { backgroundColor: c.accentSoft, borderColor: c.border }]}>
          <Text style={[styles.tileValue, { color: c.accent }]}>
            {goalsTotal > 0 ? `${goalsHit}/${goalsTotal}` : '—'}
          </Text>
          <Text style={[styles.tileLabel, { color: c.subtext }]}>Goals hit</Text>
        </View>
        <View style={[styles.tile, { backgroundColor: c.accentSoft, borderColor: c.border }]}>
          <Text style={[styles.tileValue, { color: hrvColor }]}>
            {hrv != null ? `${hrv} ms` : '—'}
          </Text>
          <Text style={[styles.tileLabel, { color: c.subtext }]}>HRV today</Text>
        </View>
        <View style={[styles.tile, { backgroundColor: c.accentSoft, borderColor: c.border }]}>
          <Text style={[styles.tileValue, { color: c.text }]}>
            {health.sleepHours != null ? `${health.sleepHours.toFixed(1)}h` : '—'}
          </Text>
          <Text style={[styles.tileLabel, { color: c.subtext }]}>Sleep</Text>
        </View>
        <View style={[styles.tile, { backgroundColor: c.accentSoft, borderColor: c.border }]}>
          <Text style={[styles.tileValue, { color: c.text }]}>
            {health.steps != null ? `${Math.round(health.steps / 1000 * 10) / 10}k` : '—'}
          </Text>
          <Text style={[styles.tileLabel, { color: c.subtext }]}>Steps</Text>
        </View>
      </View>
      {topInsight && (
        <View style={[styles.insightRow, { borderTopColor: c.border }]}>
          <Text style={[styles.insightText, { color: c.subtext }]} numberOfLines={2}>
            {topInsight.title}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: { flex: 1, minWidth: '45%', borderRadius: radius.md, borderWidth: 1, padding: spacing.sm, alignItems: 'center', gap: 2 },
  tileValue: { fontSize: 20, fontWeight: '700' },
  tileLabel: { fontSize: 11, fontWeight: '500' },
  insightRow: { borderTopWidth: 1, marginTop: spacing.sm, paddingTop: spacing.sm },
  insightText: { fontSize: 13, lineHeight: 19, fontStyle: 'italic' },
});
