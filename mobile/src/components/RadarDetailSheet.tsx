import React, { useState } from 'react';
import { Modal, View, Text, StyleSheet, Pressable, ScrollView, useColorScheme } from 'react-native';
import { getColors, spacing, radius } from '../theme';
import type { RadarCard } from '../hooks/useBriefing';

interface Props {
  card: RadarCard | null;
  onClose: () => void;
  onOpenDestination: (card: RadarCard) => void;
  onDismiss: (card: RadarCard) => void;
}

function formatAsOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const SEVERITY_LABEL: Record<string, string> = {
  material: 'Needs attention',
  watch: 'Worth watching',
  info: 'For your awareness',
};

// The PRIMARY interaction for a Today "On My Radar" card (Part 4): tapping
// a card never just jumps to the arbitrary top of a domain tab — it opens
// this full detail sheet first (complete claim, why it matters now, key
// evidence, source/as-of, available action), with "Open in Health"/"Open in
// Wealth" as a SECONDARY action underneath. Matches WeeklyReviewModal's
// established sheet pattern.
export function RadarDetailSheet({ card, onClose, onOpenDestination, onDismiss }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const visible = card != null;
  const asOfText = card ? formatAsOf(card.asOf) : null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose} transparent={false}>
      {card && (
        <View style={[styles.sheet, { backgroundColor: c.background }]}>
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: c.border }]} />
          </View>
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            <Text style={[styles.severity, { color: c.accent }]}>
              {SEVERITY_LABEL[card.severity] ?? card.severity.toUpperCase()}
            </Text>
            <Text style={[styles.headline, { color: c.text }]}>{card.headline}</Text>
            {card.whyNow ? (
              <Text style={[styles.whyNow, { color: c.text }]}>{card.whyNow}</Text>
            ) : null}

            {card.evidenceSummary ? (
              <View style={styles.evidenceBlock}>
                <Pressable onPress={() => setEvidenceOpen((v) => !v)} accessibilityRole="button" style={styles.evidenceToggle}>
                  <Text style={[styles.evidenceToggleText, { color: c.subtext }]}>
                    {evidenceOpen ? '▾ Hide evidence' : '▸ Show evidence'}
                  </Text>
                </Pressable>
                {evidenceOpen && (
                  <Text style={[styles.evidenceText, { color: c.subtext }]}>{card.evidenceSummary}</Text>
                )}
              </View>
            ) : null}

            {asOfText ? (
              <Text style={[styles.asOf, { color: c.subtext }]}>As of {asOfText}</Text>
            ) : null}

            <Pressable
              onPress={() => onOpenDestination(card)}
              style={[styles.primaryBtn, { backgroundColor: c.accent }]}
              accessibilityRole="button"
            >
              <Text style={styles.primaryBtnText}>{card.actionLabel}</Text>
            </Pressable>

            <View style={styles.secondaryRow}>
              {card.dismissable && (
                <Pressable onPress={() => onDismiss(card)} accessibilityRole="button" style={styles.secondaryBtn}>
                  <Text style={[styles.secondaryBtnText, { color: c.subtext }]}>Not useful</Text>
                </Pressable>
              )}
              <Pressable onPress={onClose} accessibilityRole="button" style={styles.secondaryBtn}>
                <Text style={[styles.secondaryBtnText, { color: c.subtext }]}>Close</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, paddingHorizontal: spacing.lg },
  handleWrap: { alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.xs },
  handle: { width: 36, height: 4, borderRadius: 2 },
  scroll: { paddingBottom: spacing.xl },
  severity: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginTop: spacing.sm, marginBottom: spacing.xs },
  headline: { fontSize: 22, fontWeight: '700', lineHeight: 28, marginBottom: spacing.sm },
  whyNow: { fontSize: 16, lineHeight: 23, marginBottom: spacing.md },
  evidenceBlock: { marginBottom: spacing.md },
  evidenceToggle: { minHeight: 44, justifyContent: 'center' },
  evidenceToggleText: { fontSize: 13, fontWeight: '600' },
  evidenceText: { fontSize: 14, lineHeight: 20, marginTop: spacing.xs },
  asOf: { fontSize: 12, marginBottom: spacing.lg },
  primaryBtn: {
    width: '100%',
    minHeight: 44,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.lg, marginTop: spacing.md },
  secondaryBtn: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
  secondaryBtnText: { fontSize: 14, fontWeight: '600' },
});
