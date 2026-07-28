import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { INSIGHT_DISMISS_URL, INSIGHT_UNDISMISS_URL, authHeaders, fetchWithTimeout } from '../config';
import type { WealthRecommendedAction } from '../hooks/useBriefing';

interface Props {
  action: WealthRecommendedAction | null | undefined;
  dataIncomplete: boolean;
  onAsk: (question: string) => void;
  onChanged: () => void;
}

/**
 * Wealth redesign (audit rec #5) — "Recommended Action": shown only when
 * NormOS has a realistic, high-confidence recommendation
 * (backend/src/services/wealth-landing.js's deriveRecommendedAction — never
 * manufactured to fill the interface). "No action needed" is rendered as a
 * quiet, deliberate state, not an empty gap. Opens a focused Ask
 * conversation with the relevant evidence already framed in the prompt,
 * since there's no single safe one-tap internal action for
 * budget/pace/transaction-review calls — Monarch remains where the actual
 * transaction/budget editing happens.
 */
function WealthActionCard({ action, dataIncomplete, onAsk, onChanged }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // Kept only so a just-confirmed explanation can be undone from the empty
  // "No action needed" state this same session (severity/reliability
  // cleanup, item 3: undo/revise) — once the card re-derives from a fresh
  // `action` prop there's nothing left to point the undo at, by design.
  const [lastConfirmedKey, setLastConfirmedKey] = useState<string | null>(null);

  const confirmIntentional = useCallback(async () => {
    if (!action?.dismissKey) return;
    setBusy(true);
    try {
      const res = await fetchWithTimeout(INSIGHT_DISMISS_URL, {
        method: 'POST', headers: authHeaders(),
        // `detail`/`kind` give the persisted explanation the same
        // category/window context WealthWhatChangedCard's own "This was
        // intentional" sends — Ask/Today/future Wealth builds all read the
        // same dismissed_insights row, so the explanation only needs to be
        // recorded once here.
        body: JSON.stringify({ key: action.dismissKey, title: action.title, detail: action.detail, kind: action.kind }),
      }, 8000);
      if (res.ok) { setConfirmed(true); setLastConfirmedKey(action.dismissKey); onChanged(); }
    } finally {
      setBusy(false);
    }
  }, [action, onChanged]);

  const undoLast = useCallback(async () => {
    if (!lastConfirmedKey) return;
    setBusy(true);
    try {
      const res = await fetchWithTimeout(INSIGHT_UNDISMISS_URL, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ key: lastConfirmedKey }),
      }, 8000);
      if (res.ok) { setConfirmed(false); setLastConfirmedKey(null); onChanged(); }
    } finally {
      setBusy(false);
    }
  }, [lastConfirmedKey, onChanged]);

  if (dataIncomplete) return null;

  const secondary = isDark ? '#AEAEB2' : c.subtext;
  const critical = action?.kind === 'cash_critical';

  if (!action || confirmed) {
    return (
      <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
        <SectionHeader emoji="✓" title="Recommended action" tint="green" />
        <Text style={[styles.noneText, { color: secondary }]}>No action needed — nothing here requires a decision right now.</Text>
        {lastConfirmedKey ? (
          <TouchableOpacity onPress={undoLast} disabled={busy} hitSlop={8} style={styles.secondaryBtn} accessibilityRole="button" accessibilityLabel="Undo, this was not intentional">
            <Text style={[styles.secondaryText, { color: secondary }]}>Undo — not intentional</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="!" title="Recommended action" tint={critical ? 'red' : 'gold'} />
      <Text style={[styles.title, { color: c.text }]} allowFontScaling>{action.title}</Text>
      {action.detail ? <Text style={[styles.detail, { color: secondary }]} allowFontScaling>{action.detail}</Text> : null}
      <View style={styles.buttonsRow}>
        <TouchableOpacity
          onPress={() => onAsk(action.askPrompt)} style={[styles.primaryBtn, { backgroundColor: c.accent }]}
          activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="Ask about this"
        >
          <Text style={styles.primaryBtnText}>Ask about this</Text>
        </TouchableOpacity>
        {action.dismissKey ? (
          <TouchableOpacity
            onPress={confirmIntentional} disabled={busy} hitSlop={8} style={styles.secondaryBtn}
            accessibilityRole="button" accessibilityLabel="This was intentional"
          >
            <Text style={[styles.secondaryText, { color: secondary }]}>This was intentional</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  noneText: { ...typography.body, fontSize: 14, marginTop: spacing.sm },
  title: { ...typography.subtitle, fontSize: 16, fontWeight: '700', marginTop: spacing.sm },
  detail: { ...typography.body, fontSize: 14, lineHeight: 20, marginTop: 4 },
  buttonsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md },
  primaryBtn: { borderRadius: radius.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  primaryBtnText: { color: '#FFF', fontSize: 14, fontWeight: '700' },
  secondaryText: { fontSize: 13, fontWeight: '600', textDecorationLine: 'underline' },
  secondaryBtn: { minHeight: 32, justifyContent: 'center' },
});

const WealthActionCardMemo = React.memo(WealthActionCard);
export { WealthActionCardMemo as WealthActionCard };
