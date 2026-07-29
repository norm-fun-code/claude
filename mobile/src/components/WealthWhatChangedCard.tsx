import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography, shadow, colors as themeColors } from '../theme';
import { SectionHeader } from './SectionHeader';
import { ExpandableText } from './ExpandableText';
import { INSIGHT_DISMISS_URL, INSIGHT_UNDISMISS_URL, authHeaders, fetchWithTimeout } from '../config';
import type { WealthChangeCard } from '../hooks/useBriefing';

interface Props {
  items: WealthChangeCard[];
  onChanged: () => void;
  // Deep-link scroll target (same pattern as RecoveryCard's highlight/
  // onHighlightLayout) — set when either a Radar wealth-insight card or the
  // Wealth posture card's "N categories stand out" affordance wants this
  // card scrolled into view. Rows are capped at 3 and all visible without
  // further scrolling once the card itself is in view, so highlighting the
  // whole card (not a single row) is a precise enough deep-link target.
  highlight?: boolean;
  onHighlightLayout?: (y: number) => void;
}

// Severity contract (backend/src/services/wealth-landing.js) — the row's
// dot color AND its state label are both driven by the SAME `severity`
// field, so a row can never show a red/urgent dot next to reassuring copy
// (or vice versa) — the exact contradiction this cleanup fixes ("Not a
// concern" hardcoded under a red action_required row).
const SEVERITY_COLOR: Record<string, string> = {
  critical: themeColors.red,
  action: themeColors.amber,
  review: '#E8B84B',
  explained: themeColors.green,
  on_track: themeColors.green,
  unavailable: themeColors.subtext,
};
const SEVERITY_STATE_LABEL: Record<string, string> = {
  critical: 'Needs action',
  action: 'Needs action',
  review: 'Worth confirming',
  explained: 'Explained',
  on_track: 'Watching',
  unavailable: 'Data incomplete',
};

function ChangeRow({ item, onChanged, c, isDark }: {
  item: WealthChangeCard; onChanged: () => void; c: ReturnType<typeof getColors>; isDark: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const tint = SEVERITY_COLOR[item.severity] ?? c.subtext;
  const secondary = c.subtextStrong;
  const alreadyExplained = item.severity === 'explained';
  const stateLabel = confirmed ? 'Intentional' : (SEVERITY_STATE_LABEL[item.severity] ?? null);

  // "This was intentional" persists a structured explanation (see
  // WealthActionCard's confirmIntentional for the same call) — an explained
  // row never needs the button again.
  const confirmIntentional = useCallback(async () => {
    if (!item.dismissKey) return;
    setBusy(true);
    try {
      const amount = (item.evidence?.impactDollars as number | undefined) ?? (item.evidence?.actual as number | undefined) ?? null;
      const category = (item.evidence?.category as string | undefined) ?? null;
      const res = await fetchWithTimeout(INSIGHT_DISMISS_URL, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ key: item.dismissKey, title: item.title, amount, category, type: item.type }),
      }, 8000);
      if (res.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setConfirmed(true); onChanged();
      }
    } finally {
      setBusy(false);
    }
  }, [item, onChanged]);

  const dismiss = useCallback(async () => {
    if (!item.dismissKey) return;
    setBusy(true);
    setDismissed(true);
    try {
      const amount = (item.evidence?.impactDollars as number | undefined) ?? (item.evidence?.actual as number | undefined) ?? null;
      const category = (item.evidence?.category as string | undefined) ?? null;
      const res = await fetchWithTimeout(INSIGHT_DISMISS_URL, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ key: item.dismissKey, title: item.title, amount, category, type: item.type }),
      }, 8000);
      if (!res.ok) { setDismissed(false); return; }
      onChanged();
    } catch {
      setDismissed(false);
    } finally {
      setBusy(false);
    }
  }, [item, onChanged]);

  // Revising an explanation: undo the dismissal so the row (and severity
  // everywhere it's read) goes back to unresolved, then let the user
  // re-explain or leave it as a real issue.
  const undo = useCallback(async () => {
    if (!item.dismissKey) return;
    setBusy(true);
    try {
      const res = await fetchWithTimeout(INSIGHT_UNDISMISS_URL, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ key: item.dismissKey }),
      }, 8000);
      if (res.ok) { setConfirmed(false); onChanged(); }
    } finally {
      setBusy(false);
    }
  }, [item, onChanged]);

  if (dismissed) return null;

  const showUndo = (alreadyExplained || confirmed) && item.dismissKey;

  return (
    <View
      style={[styles.row, { borderBottomColor: c.border }]}
      accessibilityLabel={`${item.title}${stateLabel ? `, ${stateLabel}` : ''}${item.detail ? `. ${item.detail}` : ''}`}
    >
      <View style={styles.rowHead}>
        <View style={[styles.dot, { backgroundColor: tint }]} />
        <Text style={[styles.title, { color: c.text }]}>{item.title}</Text>
      </View>
      {item.detail ? (
        <ExpandableText text={item.detail} collapsedLines={1} style={[styles.detail, { color: secondary }]} accentColor={tint} a11yPrefix={item.title} />
      ) : null}
      {stateLabel ? <Text style={[styles.stateLabel, { color: tint }]}>{stateLabel}</Text> : null}
      {!alreadyExplained && !confirmed && item.dismissKey ? (
        <View style={styles.actionsRow}>
          <TouchableOpacity onPress={confirmIntentional} disabled={busy} hitSlop={8} style={styles.dismissBtn} accessibilityRole="button">
            <Text style={[styles.dismissText, { color: tint }]}>This was intentional</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={dismiss} disabled={busy} hitSlop={8} style={styles.dismissBtn} accessibilityRole="button">
            <Text style={[styles.dismissText, { color: secondary }]}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {showUndo ? (
        <TouchableOpacity onPress={undo} disabled={busy} hitSlop={8} style={styles.dismissBtn} accessibilityRole="button" accessibilityLabel="Undo explanation">
          <Text style={[styles.dismissText, { color: secondary }]}>Undo</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/**
 * Wealth hierarchy redesign — "Worth a look": at most three ranked
 * per-category exceptions (backend/src/services/wealth-landing.js already
 * ranks, consolidates, and caps this at 3 — this is pure presentation, no
 * client-side re-ranking or re-deriving). Renamed from "What Changed" and
 * kept visually subordinate to WealthPostureCard's overall position —
 * these are secondary exceptions, never the headline. Dismissing sends the
 * insight's own $ evidence along so a materially larger recurrence can
 * resurface later (the "materially new evidence" reactivation rule) instead
 * of staying silenced forever.
 */
function WealthWhatChangedCard({ items, onChanged, highlight, onHighlightLayout }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  if (!items.length) return null;

  return (
    <View
      style={[styles.card, { backgroundColor: c.card }, shadow(isDark), highlight && { borderWidth: 2, borderColor: c.accent }]}
      onLayout={highlight && onHighlightLayout ? (e) => onHighlightLayout(e.nativeEvent.layout.y) : undefined}
    >
      <SectionHeader emoji="↗" title="Worth a look" tint="accent" />
      {items.map((item, i) => (
        <ChangeRow key={item.dismissKey || `${item.type}-${i}`} item={item} onChanged={onChanged} c={c} isDark={isDark} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  row: { paddingVertical: spacing.sm, borderBottomWidth: 1, gap: 4 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { ...typography.subtitle, fontSize: 15, fontWeight: '600', flex: 1 },
  detail: { ...typography.body, fontSize: 13, lineHeight: 18 },
  stateLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 2 },
  actionsRow: { flexDirection: 'row', gap: spacing.md, marginTop: 4 },
  dismissBtn: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  dismissText: { fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' },
});

const WealthWhatChangedCardMemo = React.memo(WealthWhatChangedCard);
export { WealthWhatChangedCardMemo as WealthWhatChangedCard };
