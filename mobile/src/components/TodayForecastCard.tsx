import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { SectionHeader } from './SectionHeader';
import { getColors, spacing, radius, typography, shadow, FONTS } from '../theme';
import { RecoveryOrb } from './RecoveryOrb';
import type { TodayForecast } from '../hooks/useBriefing';

interface Props {
  forecast: TodayForecast | null | undefined;
}

// Forward-looking companion to the Recovery card: today's GRADE (A/B/C day) and
// how to play it, plus the sleep-debt trajectory. An A day is full send; a C day
// isn't a write-off — the goal is anything that compounds above zero.
export function TodayForecastCard({ forecast }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const cap = forecast?.capacity;
  const debt = forecast?.sleepDebt;
  const tmr = forecast?.tomorrow;
  if (!cap && !debt) return null;

  const bandColor = (b?: string) =>
    b === 'green' ? c.green : b === 'yellow' ? c.yellow : b === 'red' ? c.red : c.subtext;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="🔮" title="Today's Forecast" tint="violet" />

      {cap && (
        <View style={styles.gradeRow}>
          <RecoveryOrb grade={cap.grade} band={cap.band} size={62} />
          <View style={styles.gradeBody}>
            <Text style={[styles.headline, { color: c.text }]}>{cap.headline}</Text>
            {!!cap.detail && <Text style={[styles.detail, { color: c.subtext }]}>{cap.detail}</Text>}
          </View>
        </View>
      )}

      {cap?.prescription ? (
        <Text style={[styles.prescription, { color: c.text }]}>{cap.prescription}</Text>
      ) : null}

      {debt?.detail ? (
        <View style={[styles.debtRow, { borderTopColor: c.border }]}>
          <Text style={[styles.debtLabel, { color: c.subtext }]}>SLEEP DEBT</Text>
          <Text style={[styles.debtText, { color: c.subtext }]}>{debt.detail}</Text>
        </View>
      ) : null}

      {tmr ? (
        <View style={[styles.debtRow, { borderTopColor: c.border }]}>
          <View style={styles.tmrHead}>
            <View style={[styles.tmrDot, { backgroundColor: bandColor(tmr.band) }]} />
            <Text style={[styles.debtLabel, { color: c.subtext, marginBottom: 0 }]}>TOMORROW'S LEAN</Text>
            {tmr.confidence != null && (
              <Text style={[styles.tmrConf, { color: c.subtext }]}>{tmr.confidence}% confidence</Text>
            )}
          </View>
          <Text style={[styles.debtText, { color: c.subtext }]}>{tmr.detail} {tmr.lever}</Text>
          {!!tmr.contextNote && (
            <Text style={[styles.contextNote, { color: c.text }]}>💬 {tmr.contextNote}</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  kicker: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: spacing.sm },
  gradeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  gradeBadge: {
    width: 52, height: 52, borderRadius: 26, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  gradeLetter: { fontFamily: FONTS.displayHeavy, fontSize: 28, fontWeight: '800', letterSpacing: -1 },
  gradeBody: { flex: 1 },
  headline: { ...typography.subtitle, fontSize: 17, fontWeight: '700' },
  detail: { ...typography.body, fontSize: 13, marginTop: 1 },
  prescription: { ...typography.body, fontSize: 14, lineHeight: 21, marginTop: spacing.sm },
  debtRow: { borderTopWidth: 1, marginTop: spacing.md, paddingTop: spacing.sm },
  debtLabel: { ...typography.label, fontSize: 9, marginBottom: 3 },
  debtText: { fontSize: 13, lineHeight: 19 },
  tmrHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  tmrDot: { width: 8, height: 8, borderRadius: 4 },
  tmrConf: { fontSize: 10, marginLeft: 'auto', fontStyle: 'italic' },
  contextNote: { fontSize: 13, lineHeight: 19, marginTop: 4, fontStyle: 'italic' },
});
