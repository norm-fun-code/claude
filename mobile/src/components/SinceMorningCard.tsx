import React from 'react';
import { View, Text, Pressable, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import type { SinceMorningItem } from '../hooks/useBriefing';

interface Props {
  items: SinceMorningItem[];
  onNavigate: (destination: string) => void;
}

// "Since This Morning" — server-selected, evidence-backed post-snapshot
// changes only (see backend brain/todayCommandCenter.js's sinceMorning,
// sourced from the existing attention-policy ledger filtered to
// created_at > snapshotAt). Self-hides entirely when empty — never filler.
function SinceMorningCard({ items, onNavigate }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!items || items.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <Text style={[styles.header, { color: c.subtext }]}>SINCE THIS MORNING</Text>
      {items.map((item) => (
        <Pressable
          key={item.stableId}
          onPress={() => onNavigate(item.destination)}
          style={styles.row}
          hitSlop={4}
        >
          <View style={[styles.dot, { backgroundColor: c.accent }]} />
          <Text style={[styles.summary, { color: c.text }]} numberOfLines={2}>{item.summary}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  header: { fontSize: 10, fontWeight: '700', letterSpacing: 1.0, marginBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    minHeight: 44,
    paddingVertical: spacing.xs,
  },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  summary: { ...typography.body, fontSize: 14, lineHeight: 20, flex: 1 },
});

const SinceMorningCardMemo = React.memo(SinceMorningCard);
export { SinceMorningCardMemo as SinceMorningCard };
