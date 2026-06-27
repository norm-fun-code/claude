import React from 'react';
import { View, Text, StyleSheet, useColorScheme, Linking, TouchableOpacity } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { RelevantHighlight } from '../hooks/useBriefing';

interface Props {
  highlight: RelevantHighlight | null;
  wellbeingTheme?: string | null;
}

// Relevant-not-random: the one highlight from your Readwise + Notion library
// that speaks to today's top priority (semantic match), not a random pick.
export function LibraryCard({ highlight, wellbeingTheme }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!highlight || !highlight.content) return null;

  const byline = highlight.author
    ? `${highlight.title ?? 'Untitled'} — ${highlight.author}`
    : highlight.title ?? 'From your library';

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="📚" title="From Your Library" />

      <View style={[styles.quoteBlock, { borderLeftColor: c.accent, backgroundColor: isDark ? '#0E2E4D' : '#FAFAF8' }]}>
        <Text style={[styles.quoteText, { color: c.text }]}>{highlight.content}</Text>
      </View>

      <View style={styles.footer}>
        <Text style={[styles.byline, { color: c.subtext }]} numberOfLines={2}>
          {byline}
        </Text>
        {highlight.url ? (
          <TouchableOpacity onPress={() => Linking.openURL(highlight.url!)}>
            <Text style={[styles.link, { color: c.accent }]}>Open ↗</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Specific "why now" when the match is genuine; otherwise an honest factual
          frame — never a vague unfounded "surfaced for you" claim. */}
      <Text style={[styles.why, { color: c.subtext }]}>
        {highlight.reason
          ? `✦ ${highlight.reason}`
          : 'From your library — worth revisiting.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  quoteBlock: {
    borderLeftWidth: 3,
    paddingLeft: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    marginBottom: spacing.sm,
  },
  quoteText: {
    ...typography.body,
    fontStyle: 'italic',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  byline: {
    ...typography.caption,
    fontSize: 13,
    flex: 1,
  },
  link: {
    ...typography.caption,
    fontSize: 13,
    fontWeight: '600',
  },
  why: {
    ...typography.caption,
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: spacing.xs,
  },
});
