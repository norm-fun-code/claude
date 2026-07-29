import React from 'react';
import { Modal, View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, useColorScheme } from 'react-native';
import { getColors, spacing, radius } from '../theme';
import { WeeklyIntentionsCard } from './WeeklyIntentionsCard';
import type { WeeklyReview } from '../hooks/useBriefing';
import SheetHandle from './SheetHandle';

interface Props {
  visible: boolean;
  onClose: () => void;
  review: WeeklyReview | null;
  // Weekly-review CTA fix — only true while the canonical openWeeklyReview
  // action is genuinely fetching a review not already in hand (never for
  // the common case where the current/cached review is shown immediately).
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

// The Today redesign moves the full weekly-focus checklist + weekly-review
// narrative OFF the primary Today scroll (per the product contract: "no
// weekly-review essay remains in the primary Today flow") into their own
// dedicated destination — reached by tapping the "Weekly review is ready"
// preview. This reuses WeeklyIntentionsCard UNCHANGED (same data, same goal-
// toggle/save behavior); only WHERE it renders changed, not what it shows.
export function WeeklyReviewModal({ visible, onClose, review, loading, error, onRetry }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <View style={[styles.sheet, { backgroundColor: c.background }]}>
        <View style={styles.handleWrap}>
          <SheetHandle color={c.border} style={{ marginBottom: 0 }} />
        </View>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={[styles.title, { color: c.text }]}>Weekly Review</Text>
          {loading ? (
            <View style={styles.centerBlock} accessibilityRole="text" accessibilityLabel="Loading your weekly review">
              <ActivityIndicator color={c.accent} />
              <Text style={[styles.statusText, { color: c.subtext }]}>Loading your review…</Text>
            </View>
          ) : error ? (
            <View style={styles.centerBlock} accessibilityRole="text" accessibilityLabel={`Couldn't load this review: ${error}`}>
              <Text style={[styles.statusText, { color: c.text }]}>{error}</Text>
              <Pressable
                onPress={onRetry}
                style={[styles.retryBtn, { backgroundColor: c.accent }]}
                accessibilityRole="button"
                accessibilityLabel="Retry loading the weekly review"
              >
                <Text style={styles.doneBtnText}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            <WeeklyIntentionsCard review={review} />
          )}
          <Pressable
            onPress={onClose}
            style={[styles.doneBtn, { backgroundColor: c.accent }]}
            accessibilityRole="button"
            accessibilityLabel="Done — close weekly review"
          >
            <Text style={styles.doneBtnText}>Done</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, paddingHorizontal: spacing.lg },
  handleWrap: { alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.xs },
  scroll: { paddingBottom: spacing.xl },
  title: { fontSize: 22, fontWeight: '700', marginBottom: spacing.md },
  centerBlock: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },
  statusText: { fontSize: 15, textAlign: 'center' },
  retryBtn: {
    minHeight: 44,
    minWidth: 120,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneBtn: {
    width: '100%',
    minHeight: 44,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  doneBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
