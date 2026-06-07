import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import { WeeklyGoals, WeeklyGoalWeek } from '../hooks/useBriefing';

interface Props {
  weeklyGoals: WeeklyGoals | null | undefined;
}

function formatWeekLabel(weekStart: string): string {
  const d = new Date(`${weekStart}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function GoalSection({
  week,
  label,
  showAchievement,
  c,
}: {
  week: WeeklyGoalWeek;
  label: string;
  showAchievement: boolean;
  c: ReturnType<typeof getColors>;
}) {
  const hasGoals = week.goals && week.goals.length > 0;
  if (!hasGoals && !week.context) return null;

  return (
    <View style={styles.section}>
      <Text style={[styles.weekLabel, { color: c.subtext }]}>
        {label} · week of {formatWeekLabel(week.weekStart)}
      </Text>
      {week.context ? (
        <Text style={[styles.context, { color: c.subtext }]}>{week.context}</Text>
      ) : null}
      {week.goals.map((g, i) => {
        const marked = showAchievement && g.achieved !== undefined;
        const hit = g.achieved === true;
        const dot = marked ? (hit ? '#2E7D32' : '#C0392B') : '#9E9E9E';
        const icon = marked ? (hit ? '✓' : '✗') : '·';
        return (
          <View key={i} style={styles.goalRow}>
            <Text style={[styles.goalIcon, { color: dot }]}>{icon}</Text>
            <Text style={[styles.goalText, { color: c.text }]}>{g.text}</Text>
          </View>
        );
      })}
    </View>
  );
}

export function GoalsCard({ weeklyGoals }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!weeklyGoals) return null;
  const { current, prior } = weeklyGoals;

  // Only render if there's at least one week with goals or context.
  const hasPrior = prior && (prior.goals?.length > 0 || prior.context);
  const hasCurrent = current && (current.goals?.length > 0 || current.context);
  if (!hasPrior && !hasCurrent) return null;

  // Show prior-week achievement when at least one goal has been marked.
  const priorHasResults = prior?.goals?.some((g) => g.achieved === true || g.achieved === false) ?? false;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="🎯" title="Weekly Goals" />

      {hasPrior && (
        <GoalSection
          week={prior!}
          label="Last week"
          showAchievement={priorHasResults}
          c={c}
        />
      )}

      {hasCurrent && (
        <View style={[hasPrior && styles.divider, { borderColor: c.border }]}>
          <GoalSection
            week={current!}
            label="This week"
            showAchievement={false}
            c={c}
          />
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
  section: {
    paddingTop: spacing.xs,
  },
  divider: {
    borderTopWidth: 1,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
  weekLabel: {
    ...typography.label,
    fontSize: 10,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  context: {
    ...typography.body,
    fontSize: 13,
    fontStyle: 'italic',
    marginBottom: spacing.xs,
  },
  goalRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    paddingVertical: 3,
  },
  goalIcon: {
    ...typography.subtitle,
    fontSize: 14,
    width: 18,
  },
  goalText: {
    ...typography.body,
    fontSize: 14,
    flex: 1,
  },
});
