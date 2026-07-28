import React from 'react';
import { Modal, View, Text, StyleSheet, Pressable, ScrollView, useColorScheme } from 'react-native';
import { getColors, spacing, radius } from '../theme';
import { WeeklyIntentionsCard } from './WeeklyIntentionsCard';
import type { WeeklyReview } from '../hooks/useBriefing';
import SheetHandle from './SheetHandle';

interface Props {
  visible: boolean;
  onClose: () => void;
  review: WeeklyReview | null;
}

// The Today redesign moves the full weekly-focus checklist + weekly-review
// narrative OFF the primary Today scroll (per the product contract: "no
// weekly-review essay remains in the primary Today flow") into their own
// dedicated destination — reached by tapping the "Weekly review is ready"
// preview. This reuses WeeklyIntentionsCard UNCHANGED (same data, same goal-
// toggle/save behavior); only WHERE it renders changed, not what it shows.
export function WeeklyReviewModal({ visible, onClose, review }: Props) {
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
          <WeeklyIntentionsCard review={review} />
          <Pressable onPress={onClose} style={[styles.doneBtn, { backgroundColor: c.accent }]}>
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
  doneBtn: {
    width: '100%',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  doneBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
