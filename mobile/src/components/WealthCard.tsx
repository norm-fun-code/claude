import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { Wealth } from '../hooks/useBriefing';
import { WEALTH_PLAN_URL, authHeaders, fetchWithTimeout } from '../config';

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
type PlanBaseline = { startingLiquid: number | null; k401Start: number | null } | null;

export function WealthCard({ wealth }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [hidden, setHidden] = useState(false);
  const [plan, setPlan] = useState<PlanBaseline>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithTimeout(WEALTH_PLAN_URL, { headers: authHeaders() });
        if (!res.ok) return;
        const d = await res.json();
        if (d.available) setPlan({ startingLiquid: d.startingLiquid, k401Start: d.k401Start });
      } catch {}
    })();
  }, []);

  if (!wealth) return null;

  // Plan baseline = liquid + 401k at plan start (2026)
  const planBaseNW =
    plan && (plan.startingLiquid != null || plan.k401Start != null)
      ? (plan.startingLiquid ?? 0) + (plan.k401Start ?? 0)
      : null;
  const planDelta = planBaseNW != null && wealth.netWorth != null ? wealth.netWorth - planBaseNW : null;

  const up = (wealth.netWorthChange ?? 0) >= 0;
  const cashflowPositive = wealth.cashflowThisWeek >= 0;
  const show = (s: string) => (hidden ? MASK : s);

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
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
        {planDelta != null && !hidden && (
          <Text style={[styles.change, { color: planDelta >= 0 ? c.green : c.red }]}>
            {`${planDelta >= 0 ? '▲' : '▼'} ${money(Math.abs(planDelta))} vs. 2026 plan start`}
          </Text>
        )}
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

      {wealth.discretionaryThisWeek != null &&
        wealth.spendingThisWeek > 0 &&
        wealth.discretionaryThisWeek / wealth.spendingThisWeek < 0.95 && (
        <Text style={[styles.discretionary, { color: c.subtext }]}>
          {show(money(wealth.discretionaryThisWeek))} discretionary (ex rent/mortgage)
        </Text>
      )}
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
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
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
  discretionary: { ...typography.caption, fontSize: 12, marginTop: spacing.sm, textAlign: 'center' },
});
