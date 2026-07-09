import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';

interface Props {
  pageTitle: string;
  notionText: string;
  quote?: string;
  insight: string;
}

function NotionCard({ pageTitle, notionText, quote, insight }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!notionText || !insight) return null;

  // Prefer the LLM-selected passage (a complete thought that matches the insight);
  // fall back to a first-line excerpt only if one wasn't provided.
  const excerpt = (quote && quote.trim())
    ? quote.trim()
    : notionText
    ? notionText.trim().split('\n').find((l) => l.trim().length > 20) ?? notionText.slice(0, 280)
    : '';

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="📖" title="Notion Wisdom" tint="gold" />

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

const NotionCardMemo = React.memo(NotionCard);
export { NotionCardMemo as NotionCard };
