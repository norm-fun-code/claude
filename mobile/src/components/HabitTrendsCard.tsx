import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { Insight } from '../hooks/useBriefing';

interface Props {
  insights: Insight[];
}

const TYPE_LABEL: Record<string, string> = {
  habit_consistency: 'STREAK',
  habit_split: 'IMPACT',
};

export function HabitTrendsCard({ insights }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!insights || insights.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <SectionHeader emoji="📊" title="Habit Trends" />
      {insights.map((ins, i) => (
        <View
          key={ins.dismissKey ?? i}
          style={[styles.item, i > 0 && { borderTopColor: c.border, borderTopWidth: 1 }]}
        >
          <Text style={[styles.tag, { color: c.accent }]}>
            {TYPE_LABEL[ins.type] ?? ins.type.toUpperCase()}
          </Text>
          <Text style={[styles.title, { color: c.text }]}>{ins.title}</Text>
          {ins.detail ? <Text style={[styles.detail, { color: c.subtext }]}>{ins.detail}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  item: { paddingTop: spacing.sm, marginTop: spacing.xs },
  tag: { ...typography.label, fontSize: 9, marginBottom: 2 },
  title: { ...typography.subtitle, fontSize: 15, marginBottom: 2 },
  detail: { ...typography.body, fontSize: 13 },
});
