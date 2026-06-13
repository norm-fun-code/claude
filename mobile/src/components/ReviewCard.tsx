import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { WeeklyReview } from '../hooks/useBriefing';

interface Action {
  title: string;
  detail: string | null;
}

interface Props {
  review: WeeklyReview | null;
  compact?: boolean;
  actions?: Action[];
}

export function ReviewCard({ review, compact = false, actions = [] }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const hasReview = review && review.headline;
  const hasActions = actions.length > 0;
  if (!hasReview && !hasActions) return null;

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
      {hasReview && (
        <>
          <SectionHeader emoji="🗓" title="Weekly Review" />
          <Text style={[styles.headline, { color: c.text }]}>{review!.headline}</Text>
          {!compact && (
            <>
              {review!.narrative ? (
                <Text style={[styles.narrative, { color: c.subtext }]}>{review!.narrative}</Text>
              ) : null}
              <Bullets label="WINS" items={review!.wins} color={c.green} />
              <Bullets label="WATCH-OUTS" items={review!.watchouts} color={c.red} />
              <Bullets label="NEXT WEEK'S FOCUS" items={review!.focus} color={c.accent} />
            </>
          )}
        </>
      )}

      {hasReview && hasActions && (
        <View style={[styles.divider, { borderColor: c.border }]} />
      )}

      {hasActions && (
        <>
          <Text style={[styles.actionsLabel, { color: c.subtext }]}>HIGHEST LEVERAGE THIS WEEK</Text>
          {actions.map((a, i) => (
            <View key={i} style={styles.action}>
              <View style={[styles.rank, { backgroundColor: c.accent }]}>
                <Text style={[styles.rankText, { color: '#fff' }]}>{i + 1}</Text>
              </View>
              <View style={styles.actionBody}>
                <Text style={[styles.actionTitle, { color: c.text }]}>{a.title}</Text>
                {a.detail ? (
                  <Text style={[styles.actionDetail, { color: c.subtext }]}>{a.detail}</Text>
                ) : null}
              </View>
            </View>
          ))}
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
  divider: { borderTopWidth: 1, marginVertical: spacing.md },
  actionsLabel: { ...typography.label, fontSize: 10, marginBottom: spacing.sm },
  action: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm, alignItems: 'flex-start' },
  rank: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  rankText: { fontSize: 13, fontWeight: '700' },
  actionBody: { flex: 1 },
  actionTitle: { ...typography.subtitle, marginBottom: 2 },
  actionDetail: { ...typography.body, fontSize: 13 },
});
