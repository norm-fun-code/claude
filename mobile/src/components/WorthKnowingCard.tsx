import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, useColorScheme, SafeAreaView, ScrollView } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { Insight } from '../hooks/useBriefing';
import { selectWorthKnowing } from '../lib/healthWorthKnowing';
import { INSIGHT_DISMISS_URL, authHeaders, fetchWithTimeout } from '../config';

interface Props {
  insights: Insight[];
}

const EVIDENCE_TIER_LABEL: Record<string, string> = {
  anomaly: 'Deviation from your baseline',
  strain: 'Multi-signal pattern',
  correlation: 'Confirmed pattern',
  sleep_impact: 'Confirmed pattern',
  activity_impact: 'Confirmed pattern',
  daytime_cardio: 'Confirmed pattern',
  cross_context: 'Cross-domain pattern',
  training_load: 'Training trend',
  habit_consistency: 'Streak milestone',
  fitness: 'Fitness trend',
  sleep_debt: 'Data quality',
  sleep_surplus: 'Data quality',
  sleep_consistency: 'Consistency trend',
  sleep_regularity: 'Consistency trend',
};

function sampleWindowFrom(evidence: Record<string, unknown> | undefined): string | null {
  if (!evidence) return null;
  const n = evidence.n;
  const asOf = evidence.asOf;
  const parts: string[] = [];
  if (typeof n === 'number') parts.push(`n=${n}`);
  if (typeof asOf === 'string') parts.push(`as of ${new Date(asOf).toLocaleDateString()}`);
  return parts.length ? parts.join(' · ') : null;
}

function InsightDetailModal({ insight, onClose }: { insight: Insight; onClose: () => void }) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const tier = EVIDENCE_TIER_LABEL[insight.type] ?? 'Observation';
  const sample = sampleWindowFrom(insight.evidence);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <SafeAreaView style={[detailStyles.root, { backgroundColor: c.background }]}>
        <View style={[detailStyles.header, { borderBottomColor: c.border }]}>
          <Text style={[detailStyles.tier, { color: c.accent }]}>{tier}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <Text style={[detailStyles.close, { color: c.subtext }]}>Done</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={detailStyles.content}>
          <Text style={[detailStyles.title, { color: c.text }]}>{insight.title}</Text>
          {insight.detail ? <Text style={[detailStyles.detail, { color: c.subtext }]}>{insight.detail}</Text> : null}
          {sample ? <Text style={[detailStyles.sample, { color: c.subtext }]}>{sample}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const detailStyles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.md, borderBottomWidth: 1 },
  tier: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  close: { fontSize: 15, fontWeight: '600' },
  content: { padding: spacing.lg, gap: spacing.sm },
  title: { fontSize: 20, fontWeight: '700', lineHeight: 27 },
  detail: { fontSize: 15, lineHeight: 22, marginTop: spacing.sm },
  sample: { fontSize: 12, marginTop: spacing.md, fontStyle: 'italic' },
});

/**
 * Health tab redesign (audit rec #4) — "Worth knowing": at most 2 ranked
 * health developments (never the full findings feed), each with a direct
 * drill-in to that exact insight. Ranking/dedup is pure
 * (mobile/src/lib/healthWorthKnowing.ts) over the server-curated
 * `healthInsights` the landing page already received — no new insight
 * generation, no re-ranking authority.
 */
function WorthKnowingCard({ insights }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Insight | null>(null);

  const top = selectWorthKnowing(insights).filter((i) => !i.dismissKey || !hidden.has(i.dismissKey));
  if (top.length === 0) return null;

  const dismiss = (ins: Insight) => {
    const key = ins.dismissKey;
    if (!key) return;
    setHidden((prev) => new Set(prev).add(key));
    fetchWithTimeout(INSIGHT_DISMISS_URL, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ key, title: ins.title }) }, 8000).catch(() => {});
  };

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="💡" title="Worth knowing" tint="violet" />
      {top.map((ins, idx) => (
        <TouchableOpacity
          key={ins.dismissKey ?? ins.title}
          onPress={() => setDetail(ins)}
          activeOpacity={0.7}
          style={[styles.row, idx > 0 && { borderTopWidth: 1, borderTopColor: c.border }]}
        >
          <View style={styles.rowBody}>
            <Text style={[styles.title, { color: c.text }]}>{ins.title}</Text>
            {ins.detail ? <Text style={[styles.detail, { color: c.subtext }]} numberOfLines={2}>{ins.detail}</Text> : null}
          </View>
          <View style={styles.rowActions}>
            {ins.dismissKey ? (
              <TouchableOpacity onPress={() => dismiss(ins)} hitSlop={8} style={styles.dismissBtn}>
                <Text style={[styles.dismissText, { color: c.subtext }]}>×</Text>
              </TouchableOpacity>
            ) : null}
            <Text style={[styles.chevron, { color: c.border }]}>›</Text>
          </View>
        </TouchableOpacity>
      ))}
      {detail ? <InsightDetailModal insight={detail} onClose={() => setDetail(null)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, gap: spacing.sm },
  rowBody: { flex: 1 },
  title: { ...typography.body, fontWeight: '600', fontSize: 14 },
  detail: { ...typography.caption, fontSize: 12, lineHeight: 17, marginTop: 2 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  dismissBtn: { padding: 4 },
  dismissText: { fontSize: 16, fontWeight: '600' },
  chevron: { fontSize: 18, fontWeight: '300' },
});

const WorthKnowingCardMemo = React.memo(WorthKnowingCard);
export { WorthKnowingCardMemo as WorthKnowingCard };
