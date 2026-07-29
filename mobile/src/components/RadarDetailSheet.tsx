import React, { useEffect, useRef } from 'react';
import {
  Modal, View, Text, StyleSheet, Pressable, ScrollView, useColorScheme,
  Animated, PanResponder, Dimensions, AccessibilityInfo, Platform,
} from 'react-native';
import { getColors, spacing, radius } from '../theme';
import { presentationForAttentionClass } from '../lib/radarPresentation';
import type { RadarCard } from '../hooks/useBriefing';
import SheetHandle from './SheetHandle';

interface Props {
  card: RadarCard | null;
  onClose: () => void;
  onOpenDestination: (card: RadarCard) => void;
  onDismiss: (card: RadarCard) => void;
  /** Device-bottom safe-area inset (App.tsx already computes this once) —
   *  so the sheet's own bottom padding clears the home indicator instead of
   *  guessing a flat number per platform. */
  bottomInset?: number;
}

function formatAsOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const DISMISS_DRAG_THRESHOLD = 80; // px of downward drag on the handle before a release counts as "dismiss"
const SCREEN_HEIGHT = Dimensions.get('window').height;
const MAX_SHEET_HEIGHT = SCREEN_HEIGHT * 0.85; // compact/medium detent — content-sized, never full-screen

// The PRIMARY interaction for a Today "On My Radar" card: tapping a card
// never just jumps to the arbitrary top of a domain tab — it opens this
// content-sized bottom sheet first (semantic status, headline, why it
// matters now, distinct evidence, action), with "Open in Health"/"Open in
// Wealth" as the primary CTA and quiet secondary actions underneath.
//
// A content-sized bottom sheet (not a full-page formSheet) built on RN's
// native Modal + Animated + PanResponder — no bottom-sheet library is
// installed in this app (no react-native-gesture-handler either), so drag-
// to-dismiss is implemented with PanResponder, which ships in RN core.
export function RadarDetailSheet({ card, onClose, onOpenDestination, onDismiss, bottomInset = 0 }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const visible = card != null;
  const asOfText = card ? formatAsOf(card.asOf) : null;
  const presentation = presentationForAttentionClass(card?.attentionClass);

  // Slide-up/down animation, driven manually (Modal's own animationType is
  // "none" here) so the sheet can also be dragged closed mid-gesture.
  const translateY = useRef(new Animated.Value(MAX_SHEET_HEIGHT)).current;
  useEffect(() => {
    if (visible) {
      translateY.setValue(MAX_SHEET_HEIGHT);
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 260 }).start();
      // Screen-reader users land on the sheet's content, not wherever focus
      // happened to be on the page underneath.
      AccessibilityInfo.announceForAccessibility?.(`${presentation.label}. ${card?.headline ?? ''}`);
    }
  }, [visible]);

  const closeAnimated = (after?: () => void) => {
    Animated.timing(translateY, { toValue: MAX_SHEET_HEIGHT, duration: 180, useNativeDriver: true }).start(() => after?.());
  };

  // Modal-collision fix: presenting a second native Modal (e.g. the weekly
  // review) in the SAME tick as this Modal's `visible` flips to false is
  // unreliable — the JS slide-out animation finishing does not mean the
  // underlying native modal has actually finished dismissing, so iOS can
  // silently drop the second `present` call. Instead of opening the
  // destination directly from the JS animation callback, stash it here and
  // let the Modal's own `onDismiss` (fires once the native dismissal has
  // truly completed) trigger it. `pendingDestination` is cleared as soon as
  // it's consumed, from whichever path fires first, so it's never double-run.
  const pendingDestination = useRef<RadarCard | null>(null);
  const consumePendingDestination = () => {
    const pending = pendingDestination.current;
    pendingDestination.current = null;
    if (pending) onOpenDestination(pending);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_evt, gesture) => Math.abs(gesture.dy) > 4,
      onPanResponderMove: (_evt, gesture) => {
        if (gesture.dy > 0) translateY.setValue(gesture.dy);
      },
      onPanResponderRelease: (_evt, gesture) => {
        if (gesture.dy > DISMISS_DRAG_THRESHOLD) {
          closeAnimated(onClose);
        } else {
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 260 }).start();
        }
      },
    })
  ).current;

  const handleClose = () => closeAnimated(onClose);
  // Close normally (same path as the Close button) and let the Modal's
  // onDismiss fire the actual navigation once the native dismiss is truly
  // done — see pendingDestination above. Modal's onDismiss is iOS-only, so
  // on Android (no cross-modal native-transition collision in practice) the
  // JS animation callback itself is the trigger instead.
  const handleOpenDestination = () => {
    if (!card) return;
    pendingDestination.current = card;
    closeAnimated(() => {
      onClose();
      if (Platform.OS !== 'ios') consumePendingDestination();
    });
  };
  const handleDismiss = () => { if (card) closeAnimated(() => onDismiss(card)); };

  return (
    <Modal visible={visible} animationType="none" transparent onRequestClose={handleClose} onDismiss={consumePendingDestination}>
      {card && (
        <View style={styles.root}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={handleClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          <Animated.View
            style={[
              styles.sheet,
              { backgroundColor: c.background, maxHeight: MAX_SHEET_HEIGHT, transform: [{ translateY }] },
            ]}
            accessibilityViewIsModal
          >
            <View {...panResponder.panHandlers} style={styles.handleWrap}>
              <SheetHandle color={c.border} style={{ marginBottom: 0 }} />
            </View>
            <ScrollView
              contentContainerStyle={[styles.scroll, { paddingBottom: spacing.lg + bottomInset }]}
              showsVerticalScrollIndicator={false}
            >
              {/* 1. Semantic status */}
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, { backgroundColor: c[presentation.colorToken] ?? c.subtext }]} />
                <Text
                  style={[styles.status, { color: c[presentation.colorToken] ?? c.subtext }]}
                  accessibilityRole="text"
                >
                  {presentation.label.toUpperCase()}
                </Text>
              </View>

              {/* 2. Headline */}
              <Text style={[styles.headline, { color: c.text }]} accessibilityRole="header">{card.headline}</Text>

              {/* 3. Concise "why now" */}
              {card.whyNow ? (
                <Text style={[styles.whyNow, { color: c.text }]}>{card.whyNow}</Text>
              ) : null}

              {/* 4. Distinct evidence/provenance — compact by construction
                  (structured items or one short sentence), so it's always
                  shown directly rather than hidden behind a toggle; a toggle
                  adds a tap for content this short, not real economy. */}
              {card.evidenceItems && card.evidenceItems.length > 0 ? (
                <View style={[styles.evidenceCard, { backgroundColor: c.card }]}>
                  {card.evidenceItems.map((item, i) => (
                    <View
                      key={`${item.label}-${i}`}
                      style={[styles.evidenceRow, i > 0 && { borderTopColor: c.border, borderTopWidth: StyleSheet.hairlineWidth }]}
                    >
                      <Text style={[styles.evidenceLabel, { color: c.subtext }]}>{item.label}</Text>
                      <Text style={[styles.evidenceValue, { color: c.text }]}>{item.value}</Text>
                    </View>
                  ))}
                </View>
              ) : card.evidenceSummary ? (
                <Text style={[styles.evidenceSummary, { color: c.subtext }]}>{card.evidenceSummary}</Text>
              ) : null}

              {asOfText ? (
                <Text style={[styles.asOf, { color: c.subtext }]}>As of {asOfText}</Text>
              ) : null}

              {/* 5. Primary CTA */}
              <Pressable
                onPress={handleOpenDestination}
                style={[styles.primaryBtn, { backgroundColor: c.accent }]}
                accessibilityRole="button"
                accessibilityLabel={card.actionLabel}
              >
                <Text style={styles.primaryBtnText} allowFontScaling>{card.actionLabel}</Text>
              </Pressable>

              {/* 6. Quiet secondary actions */}
              <View style={styles.secondaryRow}>
                {card.dismissable && (
                  <Pressable onPress={handleDismiss} accessibilityRole="button" accessibilityLabel="Not useful — dismiss this card" style={styles.secondaryBtn}>
                    <Text style={[styles.secondaryBtnText, { color: c.subtext }]}>Not useful</Text>
                  </Pressable>
                )}
                <Pressable onPress={handleClose} accessibilityRole="button" accessibilityLabel="Close" style={styles.secondaryBtn}>
                  <Text style={[styles.secondaryBtnText, { color: c.subtext }]}>Close</Text>
                </Pressable>
              </View>
            </ScrollView>
          </Animated.View>
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    overflow: 'hidden',
  },
  handleWrap: { alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.xs, minHeight: 28 },
  scroll: { paddingTop: spacing.xs },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.sm, marginBottom: spacing.xs },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  status: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  headline: { fontSize: 21, fontWeight: '700', lineHeight: 27, marginBottom: spacing.sm },
  whyNow: { fontSize: 15, lineHeight: 21, marginBottom: spacing.md },
  evidenceCard: { borderRadius: radius.md, marginBottom: spacing.md, overflow: 'hidden' },
  evidenceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: spacing.md },
  evidenceLabel: { fontSize: 13 },
  evidenceValue: { fontSize: 13, fontWeight: '600' },
  evidenceSummary: { fontSize: 13, lineHeight: 19, marginBottom: spacing.md },
  asOf: { fontSize: 12, marginBottom: spacing.md },
  primaryBtn: {
    width: '100%',
    minHeight: 44,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.lg, marginTop: spacing.md },
  secondaryBtn: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
  secondaryBtnText: { fontSize: 14, fontWeight: '600' },
});
