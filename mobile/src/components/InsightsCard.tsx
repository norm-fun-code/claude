import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { Insight } from '../hooks/useBriefing';
import { INSIGHT_DISMISS_URL, authHeaders, fetchWithTimeout } from '../config';

interface Props {
  insights: Insight[];
}

const TYPE_LABEL: Record<string, string> = {
  trend: 'TREND',
  correlation: 'PATTERN',
  anomaly: 'VS YOUR BASELINE',
  savings_rate: 'SAVINGS RATE',
  spending_pattern: 'SPENDING',
  over_budget: 'BUDGET',
  under_budget: 'UNDER BUDGET',
  subscriptions: 'SUBSCRIPTIONS',
  subscription_review: 'REVIEW',
  net_worth_path: 'NET WORTH PATH',
  recovery: 'RECOVERY',
  sleep_debt: 'SLEEP',
  sleep_consistency: 'SLEEP',
  sleep_impact: 'SLEEP IMPACT',
  training_load: 'TRAINING LOAD',
  activity_impact: 'EXERCISE IMPACT',
  habit_consistency: 'HABIT STREAK',
  habit_split: 'HABIT IMPACT',
  cross_context: 'CROSS-DOMAIN',
  investments: 'INVESTMENTS',
};

// The intelligence findings — trends and confirmed cross-domain patterns —
// shown as a clean list. Each is dismissible: some flags are nothing you're
// concerned about (e.g. a recurring car payment shown as "review"), so a ×
// removes it and it stays gone across rebuilds.
export function InsightsCard({ insights }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  // Locally hidden keys for instant feedback before the server round-trips.
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const dismiss = (ins: Insight) => {
    const key = ins.dismissKey;
    if (!key) return;
    setHidden((prev) => new Set(prev).add(key)); // optimistic
    fetchWithTimeout(
      INSIGHT_DISMISS_URL,
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ key, title: ins.title }) },
      8000
    ).catch(() => {
      // Revert on failure so the user can retry.
      setHidden((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    });
  };

  const visible = (insights || []).filter((ins) => !(ins.dismissKey && hidden.has(ins.dismissKey)));
  if (visible.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="↗" title="What The Data Shows" />
      {visible.map((ins, i) => (
        <View key={ins.dismissKey ?? i} style={[styles.item, i > 0 && { borderTopColor: c.border, borderTopWidth: 1 }]}>
          <View style={styles.itemBody}>
            <Text style={[styles.tag, { color: c.accent }]}>{TYPE_LABEL[ins.type] ?? ins.type.toUpperCase()}</Text>
            <Text style={[styles.title, { color: c.text }]}>{ins.title}</Text>
            {ins.detail ? <Text style={[styles.detail, { color: c.subtext }]}>{ins.detail}</Text> : null}
          </View>
          {ins.dismissKey ? (
            <TouchableOpacity onPress={() => dismiss(ins)} hitSlop={10} style={styles.dismissBtn} accessibilityLabel="Dismiss insight">
              <Text style={[styles.dismissX, { color: c.subtext }]}>×</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  item: { flexDirection: 'row', alignItems: 'flex-start', paddingTop: spacing.sm, marginTop: spacing.xs },
  itemBody: { flex: 1 },
  tag: { ...typography.label, fontSize: 9, marginBottom: 2 },
  title: { ...typography.subtitle, fontSize: 15, marginBottom: 2 },
  detail: { ...typography.body, fontSize: 13 },
  dismissBtn: { paddingLeft: spacing.sm, paddingTop: 2, marginTop: -2 },
  dismissX: { fontSize: 22, fontWeight: '400', lineHeight: 24 },
});
