import React from 'react';
import { View, Text, Pressable, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import type { SinceMorningItem } from '../hooks/useBriefing';
import { ExpandableText } from './ExpandableText';

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
        <View key={item.stableId} style={styles.row}>
          <View style={[styles.dot, { backgroundColor: c.accent }]} />
          <View style={styles.textCol}>
            {/* Summary navigates (the row's original behavior); detail is a
                separate tap target that expands in place instead — the two
                were previously one Pressable that only ever navigated, so a
                truncated detail line had no way to be read in full. */}
            <Pressable onPress={() => onNavigate(item.destination)} hitSlop={4}>
              <Text style={[styles.summary, { color: c.text }]} numberOfLines={2}>{item.summary}</Text>
            </Pressable>
            {item.detail ? (
              <ExpandableText
                text={item.detail}
                collapsedLines={2}
                style={[styles.detail, { color: c.subtext }]}
                accentColor={c.accent}
                a11yPrefix={item.summary}
              />
            ) : null}
          </View>
        </View>
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
  textCol: { flex: 1 },
  summary: { ...typography.body, fontSize: 14, lineHeight: 20 },
  detail: { ...typography.body, fontSize: 12, lineHeight: 16, marginTop: 2 },
});

const SinceMorningCardMemo = React.memo(SinceMorningCard);
export { SinceMorningCardMemo as SinceMorningCard };
