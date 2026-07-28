import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow, colors as themeColors } from '../theme';
import { SectionHeader } from './SectionHeader';
import { INSIGHT_DISMISS_URL, authHeaders, fetchWithTimeout } from '../config';
import type { WealthChangeCard } from '../hooks/useBriefing';

interface Props {
  items: WealthChangeCard[];
  onChanged: () => void;
}

const CLASS_COLOR: Record<string, string> = {
  action_required: themeColors.red,
  watch: themeColors.yellow,
  positive: themeColors.green,
  informational: '#8E8E93',
};

function ChangeRow({ item, onChanged, c, isDark }: {
  item: WealthChangeCard; onChanged: () => void; c: ReturnType<typeof getColors>; isDark: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const tint = CLASS_COLOR[item.attentionClass] ?? c.subtext;

  const dismiss = useCallback(async () => {
    if (!item.dismissKey) return;
    setBusy(true);
    setDismissed(true);
    try {
      const amount = (item.evidence?.impactDollars as number | undefined) ?? (item.evidence?.actual as number | undefined) ?? null;
      const res = await fetchWithTimeout(INSIGHT_DISMISS_URL, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ key: item.dismissKey, title: item.title, amount }),
      }, 8000);
      if (!res.ok) { setDismissed(false); return; }
      onChanged();
    } catch {
      setDismissed(false);
    } finally {
      setBusy(false);
    }
  }, [item, onChanged]);

  if (dismissed) return null;

  return (
    <View style={[styles.row, { borderBottomColor: c.border }]}>
      <View style={styles.rowHead}>
        <View style={[styles.dot, { backgroundColor: tint }]} />
        <Text style={[styles.title, { color: c.text }]}>{item.title}</Text>
      </View>
      {item.detail ? <Text style={[styles.detail, { color: c.subtext }]}>{item.detail}</Text> : null}
      {item.dismissKey ? (
        <TouchableOpacity onPress={dismiss} disabled={busy} hitSlop={8} style={styles.dismissBtn}>
          <Text style={[styles.dismissText, { color: c.subtext }]}>Not a concern</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/**
 * Wealth redesign (audit rec #5) — "What Changed": at most three ranked
 * developments (backend/src/services/wealth-landing.js already ranks,
 * consolidates, and caps this at 3 — this is pure presentation, no
 * client-side re-ranking or re-deriving). Dismissing sends the insight's own
 * $ evidence along so a materially larger recurrence can resurface later
 * (the "materially new evidence" reactivation rule) instead of staying
 * silenced forever.
 */
function WealthWhatChangedCard({ items, onChanged }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  if (!items.length) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="↗" title="What changed" tint="accent" />
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
  dismissBtn: { marginTop: 2, alignSelf: 'flex-start' },
  dismissText: { fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' },
});

const WealthWhatChangedCardMemo = React.memo(WealthWhatChangedCard);
export { WealthWhatChangedCardMemo as WealthWhatChangedCard };
