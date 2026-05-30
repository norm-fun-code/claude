import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { WeeklyReview } from '../hooks/useBriefing';

interface Props {
  review: WeeklyReview | null;
  compact?: boolean; // compact = headline only (for the Today tab)
}

// The weekly "board of directors" review. Compact shows just the headline;
// full shows the narrative, wins, watch-outs, and next-week focus.
export function ReviewCard({ review, compact = false }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  if (!review || !review.headline) return null;

  const Bullets = ({ label, items, color }: { label: string; items?: string[]; color: string }) =>
    items && items.length ? (
      <View style={styles.block}>
        <Text style={[styles.blockLabel, { color: c.subtext }]}>{label}</Text>
        {items.map((it, i) => (
          <View key={i} style={styles.bulletRow}>
            <View style={[styles.dot, { backgroundColor: color }]} />
            <Text style={[styles.bulletText, { color: c.text }]}>{it}</Text>
          </View>
        ))}
      </View>
    ) : null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <SectionHeader emoji="🗓" title="Weekly Review" />
      <Text style={[styles.headline, { color: c.text }]}>{review.headline}</Text>

      {!compact && (
        <>
          {review.narrative ? (
            <Text style={[styles.narrative, { color: c.subtext }]}>{review.narrative}</Text>
          ) : null}
          <Bullets label="WINS" items={review.wins} color={c.green} />
          <Bullets label="WATCH-OUTS" items={review.watchouts} color={c.red} />
          <Bullets label="NEXT WEEK'S FOCUS" items={review.focus} color={c.accent} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  headline: { ...typography.subtitle, fontSize: 17, marginBottom: spacing.xs },
  narrative: { ...typography.body, fontSize: 14, marginBottom: spacing.sm },
  block: { marginTop: spacing.sm },
  blockLabel: { ...typography.label, fontSize: 10, marginBottom: spacing.xs },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.xs },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  bulletText: { ...typography.body, fontSize: 14, flex: 1 },
});
