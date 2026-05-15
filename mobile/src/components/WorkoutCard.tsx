import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, colors } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { Workout } from '../hooks/useBriefing';
import type { HRVStatus } from '../hooks/useHealthData';

interface Props {
  workout: Workout;
  hrvStatus?: HRVStatus;
}

function workoutEmoji(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes('zone 2') || lower.includes('walk')) return '🚶';
  if (lower.includes('interval')) return '⚡️';
  if (lower.includes('push')) return '💪';
  if (lower.includes('pull')) return '🏋️';
  if (lower.includes('recovery') || lower.includes('mobility')) return '🧘';
  return '🏃';
}

function getHRVRecommendation(hrvStatus: HRVStatus | undefined, workout: Workout): string {
  if (!hrvStatus || hrvStatus === 'unknown') return workout.hrvNote;
  if (hrvStatus === 'green') return 'HRV is high — train as planned. You\'re recovered.';
  if (hrvStatus === 'yellow') return 'HRV is moderate — consider dropping intensity by 10–20%.';
  return 'HRV is low — swap to mobility or an easy walk today.';
}

function getHRVColor(status: HRVStatus | undefined): string {
  if (status === 'green') return colors.green;
  if (status === 'yellow') return colors.yellow;
  if (status === 'red') return colors.red;
  return colors.subtext;
}

export function WorkoutCard({ workout, hrvStatus }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const recommendation = getHRVRecommendation(hrvStatus, workout);
  const hrvColor = getHRVColor(hrvStatus);
  const emoji = workoutEmoji(workout.type);

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="🏋️" title="Today's Workout" />

      {/* Workout type */}
      <View style={styles.typeRow}>
        <Text style={styles.typeEmoji}>{emoji}</Text>
        <Text style={[styles.typeName, { color: c.text }]}>{workout.type}</Text>
      </View>

      {/* Details row */}
      <View style={styles.detailsRow}>
        {workout.duration && (
          <View style={[styles.badge, { backgroundColor: isDark ? '#2A2A28' : '#F3F3F0' }]}>
            <Text style={[styles.badgeText, { color: c.subtext }]}>⏱ {workout.duration}</Text>
          </View>
        )}
        {workout.hrTarget && (
          <View style={[styles.badge, { backgroundColor: isDark ? '#2A2A28' : '#F3F3F0' }]}>
            <Text style={[styles.badgeText, { color: c.subtext }]}>♥ {workout.hrTarget}</Text>
          </View>
        )}
        <View style={[styles.badge, { backgroundColor: isDark ? '#2A2A28' : '#F3F3F0' }]}>
          <Text style={[styles.badgeText, { color: c.subtext }]}>🥩 {workout.protein} protein</Text>
        </View>
      </View>

      {/* HRV recommendation */}
      <View style={[styles.recommendation, { borderLeftColor: hrvColor, backgroundColor: isDark ? '#1A1A18' : '#FAFAF8' }]}>
        <Text style={[styles.recommendationText, { color: c.subtext }]}>{recommendation}</Text>
      </View>
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
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  typeEmoji: {
    fontSize: 28,
  },
  typeName: {
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: -0.5,
    flex: 1,
  },
  detailsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  badge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  badgeText: {
    ...typography.caption,
    fontSize: 13,
  },
  recommendation: {
    borderLeftWidth: 3,
    paddingLeft: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  },
  recommendationText: {
    ...typography.body,
    fontSize: 14,
  },
});
