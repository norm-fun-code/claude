import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme, type NativeSyntheticEvent, type TextLayoutEventData } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { SectionHeader } from './SectionHeader';
import { getColors, spacing, radius, typography, shadow, withAlpha } from '../theme';
import type { Commitment } from '../hooks/useCommitments';

const COLLAPSED_LINES = 2;

// Pure: does this commitment have anything a "More" tap would actually reveal?
// Exported so the decision is unit-testable without rendering — a long detail
// always qualifies; a short one-line title with no detail never does (there'd
// be nothing to expand into, so no affordance should show at all).
export function canExpandCommitment(commitment: Pick<Commitment, 'detail'>, titleTruncated: boolean): boolean {
  return titleTruncated || !!commitment.detail?.trim();
}

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
  const [expanded, setExpanded] = useState(false);
  // Whether the title actually overflows COLLAPSED_LINES when collapsed —
  // onTextLayout reports the FULL wrapped line count independent of
  // numberOfLines' visual truncation, so this reflects the true content, not
  // a string-length guess (which line-wrapping at a given width can't predict).
  const [titleTruncated, setTitleTruncated] = useState(false);
  const canExpand = canExpandCommitment(commitment, titleTruncated);

  const handleTitleLayout = (e: NativeSyntheticEvent<TextLayoutEventData>) => {
    if (!expanded && e.nativeEvent.lines.length > COLLAPSED_LINES) setTitleTruncated(true);
  };

  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <TouchableOpacity
          activeOpacity={canExpand ? 0.6 : 1}
          onPress={() => { if (canExpand) setExpanded((v) => !v); }}
          disabled={!canExpand}
          accessibilityRole={canExpand ? 'button' : undefined}
          accessibilityLabel={canExpand ? `Commitment: ${commitment.title}` : undefined}
          accessibilityHint={canExpand ? (expanded ? 'Double tap to collapse' : 'Double tap to expand') : undefined}
          accessibilityState={canExpand ? { expanded } : undefined}
        >
          <Text
            style={[styles.title, { color: colors.text }]}
            numberOfLines={expanded ? undefined : COLLAPSED_LINES}
            onTextLayout={handleTitleLayout}
          >
            {commitment.title}
          </Text>
          {expanded && !!commitment.detail?.trim() && (
            <Text style={[styles.detail, { color: colors.subtext }]}>{commitment.detail}</Text>
          )}
          {canExpand && (
            <Text style={[styles.moreLess, { color: colors.accent }]}>{expanded ? 'Less' : 'More'}</Text>
          )}
        </TouchableOpacity>
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
function CommitmentsCard({ commitments, onResolve }: Props) {
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
  // flex-start (not center) so the Done/Skip buttons stay pinned to the top
  // of the row instead of drifting to the vertical middle once an expanded
  // title + detail makes the body much taller than the two action buttons.
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  rowBody: { flex: 1, gap: 5 },
  title: { ...typography.body, fontSize: 15, lineHeight: 21 },
  detail: { ...typography.body, fontSize: 13, lineHeight: 18, marginTop: 2 },
  moreLess: { fontSize: 12, fontWeight: '700', marginTop: 2 },
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

const CommitmentsCardMemo = React.memo(CommitmentsCard);
export { CommitmentsCardMemo as CommitmentsCard };
