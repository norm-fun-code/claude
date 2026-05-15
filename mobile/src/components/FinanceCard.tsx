import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';

interface Props {
  items: string[];
}

export function FinanceCard({ items }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!items || items.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="📈" title="Finance & Markets" />

      {items.map((bullet, index) => (
        <View key={index} style={styles.bulletRow}>
          <Text style={[styles.dot, { color: c.subtext }]}>•</Text>
          <Text style={[styles.bulletText, { color: c.subtext }]}>{bullet}</Text>
        </View>
      ))}
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
  bulletRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    alignItems: 'flex-start',
  },
  dot: {
    ...typography.body,
    lineHeight: 23,
  },
  bulletText: {
    ...typography.body,
    lineHeight: 23,
    flex: 1,
  },
});
