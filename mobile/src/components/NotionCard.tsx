import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';

interface Props {
  pageTitle: string;
  notionText: string;
  insight: string;
}

export function NotionCard({ pageTitle, notionText, insight }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!notionText && !insight) return null;

  // Show a short excerpt of the raw notion text as the "quote"
  const excerpt = notionText
    ? notionText.trim().split('\n').find((l) => l.trim().length > 20) ?? notionText.slice(0, 280)
    : '';

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="📖" title="Notion Wisdom" />

      {pageTitle ? (
        <Text style={[styles.pageTitle, { color: c.subtext }]}>{pageTitle}</Text>
      ) : null}

      {excerpt ? (
        <View style={[styles.quoteBlock, { borderLeftColor: c.border, backgroundColor: isDark ? '#1A1A18' : '#FAFAF8' }]}>
          <Text style={[styles.quoteText, { color: c.text }]} numberOfLines={6}>
            "{excerpt}"
          </Text>
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
  pageTitle: {
    ...typography.caption,
    fontSize: 12,
    marginBottom: spacing.sm,
    fontStyle: 'italic',
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
