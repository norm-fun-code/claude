import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { INSIGHT_DISMISS_URL, authHeaders, fetchWithTimeout } from '../config';
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

  const confirmIntentional = useCallback(async () => {
    if (!action?.dismissKey) return;
    setBusy(true);
    try {
      const res = await fetchWithTimeout(INSIGHT_DISMISS_URL, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ key: action.dismissKey, title: action.title }),
      }, 8000);
      if (res.ok) { setConfirmed(true); onChanged(); }
    } finally {
      setBusy(false);
    }
  }, [action, onChanged]);

  if (dataIncomplete) return null;

  if (!action || confirmed) {
    return (
      <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
        <SectionHeader emoji="✓" title="Recommended action" tint="green" />
        <Text style={[styles.noneText, { color: c.subtext }]}>No action needed — nothing here requires a decision right now.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="!" title="Recommended action" tint="gold" />
      <Text style={[styles.title, { color: c.text }]}>{action.title}</Text>
      {action.detail ? <Text style={[styles.detail, { color: c.subtext }]}>{action.detail}</Text> : null}
      <View style={styles.buttonsRow}>
        <TouchableOpacity onPress={() => onAsk(action.askPrompt)} style={[styles.primaryBtn, { backgroundColor: c.accent }]} activeOpacity={0.85}>
          <Text style={styles.primaryBtnText}>Ask about this</Text>
        </TouchableOpacity>
        {action.dismissKey ? (
          <TouchableOpacity onPress={confirmIntentional} disabled={busy} hitSlop={8} style={styles.secondaryBtn}>
            <Text style={[styles.secondaryText, { color: c.subtext }]}>This was intentional</Text>
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
  secondaryBtn: {},
});

const WealthActionCardMemo = React.memo(WealthActionCard);
export { WealthActionCardMemo as WealthActionCard };
