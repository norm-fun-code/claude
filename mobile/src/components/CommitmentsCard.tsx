import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { SectionHeader } from './SectionHeader';
import { getColors, spacing, radius, typography, shadow, withAlpha } from '../theme';
import type { Commitment } from '../hooks/useCommitments';

interface Props {
  commitments: Commitment[];
  onResolve: (id: number, how: 'done' | 'skip') => void;
}

// Relative due-time chip: "6:00 PM" today, "Tomorrow 9 AM", "Overdue", or
// nothing for an untimed "someday" commitment.
function dueLabel(due: string | null): { text: string; overdue: boolean } | null {
  if (!due) return null;
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const overdue = d.getTime() < now.getTime();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (overdue) return { text: 'Overdue', overdue: true };
  if (sameDay) return { text: time, overdue: false };
  if (isTomorrow) return { text: `Tomorrow ${time}`, overdue: false };
  const day = d.toLocaleDateString([], { weekday: 'short' });
  return { text: `${day} ${time}`, overdue: false };
}

function Row({ c: commitment, colors, onResolve }: { c: Commitment; colors: ReturnType<typeof getColors>; onResolve: Props['onResolve'] }) {
  const due = dueLabel(commitment.due_at);
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>{commitment.title}</Text>
        {due && (
          <View style={[styles.dueChip, { backgroundColor: due.overdue ? withAlpha('#FF6B6B', 0.16) : withAlpha(colors.accent, 0.12) }]}>
            <Ionicons name="time-outline" size={11} color={due.overdue ? '#FF6B6B' : colors.accent} />
            <Text style={[styles.dueText, { color: due.overdue ? '#FF6B6B' : colors.accent }]}>{due.text}</Text>
          </View>
        )}
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onResolve(commitment.id, 'skip'); }}
          hitSlop={8}
          style={[styles.actionBtn, { borderColor: colors.border }]}
          accessibilityLabel="Skip"
        >
          <Ionicons name="close" size={17} color={colors.subtext} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); onResolve(commitment.id, 'done'); }}
          hitSlop={8}
          style={[styles.actionBtn, styles.doneBtn]}
          accessibilityLabel="Mark done"
        >
          <Ionicons name="checkmark" size={17} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Live follow-through: what you said you'd do, still open. Self-hides when empty
// (nothing outstanding is the good state, not an empty box).
export function CommitmentsCard({ commitments, onResolve }: Props) {
  const isDark = useColorScheme() === 'dark';
  const colors = getColors(isDark);
  if (!commitments || commitments.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: colors.card }, shadow(isDark)]}>
      <SectionHeader emoji="📌" title="Commitments" tint="accent" />
      <View style={styles.list}>
        {commitments.map((c, i) => (
          <React.Fragment key={c.id}>
            {i > 0 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}
            <Row c={c} colors={colors} onResolve={onResolve} />
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  list: { marginTop: spacing.sm },
  divider: { height: 1, marginVertical: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowBody: { flex: 1, gap: 5 },
  title: { ...typography.body, fontSize: 15, lineHeight: 21 },
  dueChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  dueText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.2 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  actionBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneBtn: { backgroundColor: '#34C759', borderColor: '#34C759' },
});
