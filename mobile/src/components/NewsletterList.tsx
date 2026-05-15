import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { Newsletter } from '../hooks/useBriefing';

interface NewsletterItemProps {
  item: Newsletter;
  c: ReturnType<typeof getColors>;
  isDark: boolean;
}

function NewsletterItem({ item, c, isDark }: NewsletterItemProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <TouchableOpacity
      onPress={() => setExpanded((v) => !v)}
      activeOpacity={0.7}
      style={[styles.item, { borderBottomColor: c.border }]}
    >
      <View style={styles.itemHeader}>
        <View style={[styles.sourceBadge, { backgroundColor: isDark ? '#2A2A28' : '#F3F3F0' }]}>
          <Text style={[styles.sourceName, { color: c.subtext }]}>{item.name}</Text>
        </View>
        <Text style={[styles.expand, { color: c.subtext }]}>{expanded ? '−' : '+'}</Text>
      </View>

      <Text style={[styles.articleTitle, { color: c.text }]} numberOfLines={expanded ? undefined : 2}>
        {item.title}
      </Text>

      {expanded && (
        <Text style={[styles.summary, { color: c.subtext }]}>{item.summary}</Text>
      )}
    </TouchableOpacity>
  );
}

interface Props {
  newsletters: Newsletter[];
}

export function NewsletterList({ newsletters }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="📰" title="Newsletters" />

      {newsletters.length === 0 ? (
        <Text style={[styles.empty, { color: c.subtext }]}>No newsletters in inbox.</Text>
      ) : (
        newsletters.map((item, index) => (
          <NewsletterItem key={index} item={item} c={c} isDark={isDark} />
        ))
      )}

      <Text style={[styles.hint, { color: c.subtext }]}>Tap any item to expand the summary</Text>
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
  item: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    marginBottom: spacing.xs,
  },
  itemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  sourceBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  sourceName: {
    ...typography.label,
    fontSize: 10,
  },
  expand: {
    fontSize: 18,
    lineHeight: 20,
  },
  articleTitle: {
    ...typography.body,
    fontWeight: '500',
    lineHeight: 21,
  },
  summary: {
    ...typography.body,
    marginTop: spacing.sm,
    lineHeight: 23,
  },
  empty: {
    ...typography.body,
    fontStyle: 'italic',
    paddingVertical: spacing.xs,
  },
  hint: {
    ...typography.caption,
    marginTop: spacing.sm,
    fontStyle: 'italic',
  },
});
