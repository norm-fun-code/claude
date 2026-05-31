import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';

interface Props {
  quote: string;
  insight: string;
  title?: string;
  emoji?: string;
}

export function QuoteCard({ quote, insight, title = 'Quote + Insight', emoji = '💡' }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!quote && !insight) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji={emoji} title={title} />

      {quote ? (
        <View style={[styles.quoteBlock, { borderLeftColor: c.border, backgroundColor: isDark ? '#1A1A18' : '#FAFAF8' }]}>
          <Text style={[styles.quoteText, { color: c.text }]}>"{quote}"</Text>
        </View>
      ) : null}

      {insight ? (
        <Text style={[styles.insight, { color: c.subtext }]}>{insight}</Text>
      ) : null}
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
  quoteBlock: {
    borderLeftWidth: 3,
    paddingLeft: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
    borderRadius: radius.sm,
  },
  quoteText: {
    ...typography.body,
    fontStyle: 'italic',
    lineHeight: 24,
  },
  insight: {
    ...typography.body,
    lineHeight: 23,
  },
});
