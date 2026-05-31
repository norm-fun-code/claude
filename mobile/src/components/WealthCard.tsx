import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { Wealth } from '../hooks/useBriefing';

interface Props {
  wealth: Wealth | null;
}

function money(n: number | null) {
  if (n == null) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

const MASK = '••••••';

// Wealth snapshot from the canonical spine (Monarch import): net worth, this
// week's spending, income, and net cashflow. Tap the figure to hide all amounts
// (for when you're showing the app to someone).
export function WealthCard({ wealth }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [hidden, setHidden] = useState(false);
  if (!wealth) return null;

  const up = (wealth.netWorthChange ?? 0) >= 0;
  const cashflowPositive = wealth.cashflowThisWeek >= 0;
  const show = (s: string) => (hidden ? MASK : s);

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <View style={styles.header}>
        <SectionHeader emoji="◆" title="Net Worth" />
        <Text style={[styles.hint, { color: c.subtext }]}>{hidden ? 'tap to show' : 'tap to hide'}</Text>
      </View>

      <Pressable onPress={() => setHidden((h) => !h)}>
        <Text style={[styles.big, { color: c.text }]}>{show(money(wealth.netWorth))}</Text>
        {wealth.netWorthChange != null ? (
          <Text style={[styles.change, { color: hidden ? c.subtext : up ? c.green : c.red }]}>
            {hidden ? MASK : `${up ? '▲' : '▼'} ${money(Math.abs(wealth.netWorthChange))} over ~30 days`}
          </Text>
        ) : null}
      </Pressable>

      <View style={[styles.row, { borderTopColor: c.border }]}>
        <Stat label="Spending (7d)" value={show(money(wealth.spendingThisWeek))} color={c.text} c={c} />
        <Stat label="Income (7d)" value={show(money(wealth.incomeThisWeek))} color={c.text} c={c} />
        <Stat
          label="Net cashflow"
          value={hidden ? MASK : `${cashflowPositive ? '+' : '−'}${money(Math.abs(wealth.cashflowThisWeek))}`}
          color={hidden ? c.text : cashflowPositive ? c.green : c.red}
          c={c}
        />
      </View>
    </View>
  );
}

function Stat({ label, value, color, c }: { label: string; value: string; color: string; c: any }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: c.subtext }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hint: { fontSize: 10, fontStyle: 'italic' },
  big: { fontSize: 40, fontWeight: '300', letterSpacing: -1.5 },
  change: { ...typography.caption, fontSize: 13, marginTop: 2 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  stat: { alignItems: 'flex-start', flex: 1 },
  statValue: { ...typography.subtitle, fontWeight: '600', fontSize: 15 },
  statLabel: { ...typography.caption, fontSize: 11, marginTop: 2 },
});
