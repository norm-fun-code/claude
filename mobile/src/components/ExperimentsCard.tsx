import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { CompletedExperiment, RunningExperiment } from '../hooks/useBriefing';

interface Props {
  completed: CompletedExperiment[];
  running: RunningExperiment[];
  callout?: string;
}

function pctLabel(pct: number | null): string {
  if (pct == null) return '';
  const sign = pct > 0 ? '+' : '';
  return ` · ${sign}${Math.round(pct * 100)}%`;
}

export function ExperimentsCard({ completed, running, callout }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const hasContent = completed.length > 0 || running.length > 0;
  if (!hasContent) return null;

  const confirmed = completed.filter((e) => e.verdict === 'confirmed');
  const refuted = completed.filter((e) => e.verdict === 'refuted');
  const inconclusive = completed.filter((e) => e.verdict === 'inconclusive');

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <Text style={[styles.label, { color: c.subtext }]}>SELF-EXPERIMENTS</Text>

      {callout ? (
        <View style={[styles.callout, { backgroundColor: c.accentSoft, borderColor: c.accent }]}>
          <Text style={[styles.calloutText, { color: c.accent }]}>{callout}</Text>
        </View>
      ) : null}

      {confirmed.map((e) => (
        <View key={e.id} style={styles.row}>
          <View style={[styles.badge, { backgroundColor: '#00A86B22' }]}>
            <Text style={[styles.badgeIcon, { color: '#00A86B' }]}>✓</Text>
          </View>
          <View style={styles.body}>
            <Text style={[styles.verdict, { color: '#00A86B' }]}>CONFIRMED{pctLabel(e.pctChange)}</Text>
            <Text style={[styles.hypothesis, { color: c.text }]}>{e.hypothesis}</Text>
          </View>
        </View>
      ))}

      {refuted.map((e) => (
        <View key={e.id} style={styles.row}>
          <View style={[styles.badge, { backgroundColor: '#E2595022' }]}>
            <Text style={[styles.badgeIcon, { color: '#E25950' }]}>✗</Text>
          </View>
          <View style={styles.body}>
            <Text style={[styles.verdict, { color: '#E25950' }]}>REFUTED{pctLabel(e.pctChange)}</Text>
            <Text style={[styles.hypothesis, { color: c.text }]}>{e.hypothesis}</Text>
          </View>
        </View>
      ))}

      {inconclusive.map((e) => (
        <View key={e.id} style={styles.row}>
          <View style={[styles.badge, { backgroundColor: c.accentSoft }]}>
            <Text style={[styles.badgeIcon, { color: c.subtext }]}>~</Text>
          </View>
          <View style={styles.body}>
            <Text style={[styles.verdict, { color: c.subtext }]}>INCONCLUSIVE</Text>
            <Text style={[styles.hypothesis, { color: c.text }]}>{e.hypothesis}</Text>
          </View>
        </View>
      ))}

      {running.map((e) => (
        <View key={e.id} style={styles.row}>
          <View style={[styles.badge, { backgroundColor: '#E8A40022' }]}>
            <Text style={[styles.badgeIcon, { color: '#E8A400' }]}>⟳</Text>
          </View>
          <View style={styles.body}>
            <Text style={[styles.verdict, { color: '#E8A400' }]}>
              RUNNING{e.daysLeft != null ? ` · ${e.daysLeft}d left` : ''}
            </Text>
            <Text style={[styles.hypothesis, { color: c.text }]}>{e.hypothesis}</Text>
            {e.protocol ? (
              <Text style={[styles.protocol, { color: c.subtext }]}>{e.protocol}</Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  label: { ...typography.label, fontSize: 10, letterSpacing: 1, marginBottom: spacing.sm },
  callout: {
    borderRadius: radius.sm,
    borderWidth: 1,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  calloutText: { ...typography.body, fontSize: 14, fontStyle: 'italic' },
  row: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm, alignItems: 'flex-start' },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  badgeIcon: { fontSize: 14, fontWeight: '700' },
  body: { flex: 1 },
  verdict: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 2 },
  hypothesis: { ...typography.body, fontSize: 14 },
  protocol: { ...typography.body, fontSize: 12, marginTop: 2 },
});
