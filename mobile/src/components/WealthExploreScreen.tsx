import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { FullScreenSheet } from './FullScreenSheet';
import { Trend } from './viz/Trend';
import { getColors, spacing, radius, typography, colors as themeColors } from '../theme';
import { useSeries } from '../hooks/useSeries';
import { METRICS_HISTORY_URL } from '../config';
import type { WealthLanding } from '../hooks/useBriefing';

interface Props {
  visible: boolean;
  onClose: () => void;
  landing: WealthLanding | null | undefined;
}

function money(n: number | null | undefined): string {
  if (n == null) return '—';
  return (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
}

function Section({ title, children, c }: { title: string; children: React.ReactNode; c: ReturnType<typeof getColors> }) {
  return (
    <View style={[styles.section, { borderColor: c.border }]}>
      <Text style={[styles.sectionTitle, { color: c.text }]}>{title}</Text>
      {children}
    </View>
  );
}

/**
 * Wealth redesign (audit rec #5) — "Explore": secondary reporting the
 * landing page deliberately doesn't lead with, consolidated into ONE
 * lightweight sheet (net worth / cash flow / spending / source health)
 * rather than four separate screens or a Monarch-style full report. Every
 * number here still comes from the SAME wealthLanding projection the
 * landing page reads — this screen adds no new derivation, only more
 * detail/history for numbers already computed once.
 */
export function WealthExploreScreen({ visible, onClose, landing }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const nwSeries = useSeries(visible ? `${METRICS_HISTORY_URL}?metric=net_worth&days=90` : null);

  const numbers = landing?.numbers;

  return (
    <FullScreenSheet visible={visible} title="Explore" onClose={onClose}>
      <Section title="Net worth" c={c}>
        <Text style={[styles.bigNumber, { color: c.text }]}>{money(numbers?.netWorth?.amount)}</Text>
        {nwSeries.values.length >= 3 ? (
          <View style={{ marginTop: spacing.sm }}>
            <Trend values={nwSeries.values} color={c.accent} />
          </View>
        ) : null}
        {numbers?.netWorth?.trend ? (
          <Text style={[styles.detail, { color: c.subtext }]}>
            Trending {numbers.netWorth.trend.direction} ~{money(Math.abs(numbers.netWorth.trend.monthlyChange))}/mo — projected {money(numbers.netWorth.trend.projectedYearEnd)} by year-end.
          </Text>
        ) : null}
        {numbers?.planPace ? (
          <Text style={[styles.detail, { color: c.subtext }]}>
            {numbers.planPace.ahead ? 'Ahead of' : 'Behind'} plan pace by {money(Math.abs(numbers.planPace.delta))} ({numbers.planPace.pctYearElapsed}% through the year).
          </Text>
        ) : null}
      </Section>

      <Section title="Cash flow" c={c}>
        {numbers?.savingsRate ? (
          <>
            <Text style={[styles.detail, { color: c.text }]}>
              Savings rate (30d): <Text style={{ fontWeight: '700' }}>{numbers.savingsRate.ratePct}%</Text>
            </Text>
            <Text style={[styles.detail, { color: c.subtext }]}>
              {money(numbers.savingsRate.income)} income vs {money(numbers.savingsRate.spending)} spending over the last {numbers.savingsRate.windowDays} days.
            </Text>
          </>
        ) : (
          <Text style={[styles.detail, { color: c.subtext }]}>Not enough income data yet this window.</Text>
        )}
        {numbers?.cashBuffer ? (
          <Text style={[styles.detail, { color: numbers.cashBuffer.thin ? themeColors.yellow : c.subtext }]}>
            Cash buffer: {money(numbers.cashBuffer.amount)}{numbers.cashBuffer.thin ? ' — thin against upcoming bills.' : ''}
          </Text>
        ) : null}
      </Section>

      <Section title="Spending (this month)" c={c}>
        {numbers?.mtdDiscretionary ? (
          <Text style={[styles.detail, { color: c.text }]}>
            Discretionary MTD: <Text style={{ fontWeight: '700' }}>{money(numbers.mtdDiscretionary.amount)}</Text> (excludes rent/mortgage)
          </Text>
        ) : null}
        {(landing?.spendingDetail ?? []).map((row) => (
          <View key={row.category} style={styles.catRow}>
            <Text style={[styles.catName, { color: c.text }]}>{row.category}</Text>
            <Text style={[styles.catAmount, { color: c.subtext }]}>{money(row.amount)}</Text>
          </View>
        ))}
        {!landing?.spendingDetail?.length ? (
          <Text style={[styles.detail, { color: c.subtext }]}>No categorized spending yet this month.</Text>
        ) : null}
      </Section>

      <Section title="Source health" c={c}>
        {(landing?.sourceHealth.rows ?? []).map((row) => (
          <View key={row.id} style={styles.catRow}>
            <Text style={[styles.catName, { color: c.text }]}>{row.id}</Text>
            <Text style={[styles.catAmount, { color: row.isStale ? themeColors.yellow : themeColors.green }]}>
              {row.hoursAgo == null ? 'never synced' : `${row.hoursAgo}h ago`}{row.lastError ? ' — error' : ''}
            </Text>
          </View>
        ))}
        {landing?.sourceHealth.qualification ? (
          <Text style={[styles.detail, { color: themeColors.yellow, marginTop: spacing.xs }]}>{landing.sourceHealth.qualification}</Text>
        ) : null}
      </Section>
    </FullScreenSheet>
  );
}

const styles = StyleSheet.create({
  section: { borderTopWidth: 1, paddingVertical: spacing.md },
  sectionTitle: { ...typography.subtitle, fontSize: 16, fontWeight: '700', marginBottom: spacing.sm },
  bigNumber: { fontSize: 32, fontWeight: '300' },
  detail: { ...typography.body, fontSize: 14, lineHeight: 20, marginTop: 4 },
  catRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  catName: { ...typography.body, fontSize: 14 },
  catAmount: { ...typography.body, fontSize: 14, fontWeight: '600' },
});
