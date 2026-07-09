import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow, FONTS } from '../theme';
import { SectionHeader } from './SectionHeader';
import { Wealth } from '../hooks/useBriefing';
import { WEALTH_PLAN_URL, METRICS_HISTORY_URL, authHeaders, fetchWithTimeout } from '../config';
import { Trend } from './viz/Trend';
import { useSeries } from '../hooks/useSeries';

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
type PlanData = {
  planLiquidAtPace: number | null;
  pctYearElapsed: number | null;
} | null;

function WealthCard({ wealth }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [hidden, setHidden] = useState(false);
  const [plan, setPlan] = useState<PlanData>(null);
  const nwTrend = useSeries(`${METRICS_HISTORY_URL}?metric=net_worth&days=30`);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithTimeout(WEALTH_PLAN_URL, { headers: authHeaders() });
        if (!res.ok) return;
        const d = await res.json();
        if (d.available) setPlan({ planLiquidAtPace: d.planLiquidAtPace, pctYearElapsed: d.pctYearElapsed });
      } catch {}
    })();
  }, []);

  if (!wealth) return null;

  // Plan pace: how far ahead or behind the 2026 liquid growth plan right now.
  // planLiquidAtPace = startingLiquid + planLiquidGrowth2026 × pctYearElapsed (server-computed).
  const planDelta = plan?.planLiquidAtPace != null && wealth.netWorth != null
    ? wealth.netWorth - plan.planLiquidAtPace
    : null;

  const up = (wealth.netWorthChange ?? 0) >= 0;
  // Cashflow/income use a ROLLING 30-day window (always spans a full pay cycle),
  // so lumpy/biweekly income never produces a misleading "$7 income, −$3,854
  // cashflow" the way a 7-day window does. Budgets stay calendar-MTD elsewhere.
  const cashflowMonthPositive = (wealth.cashflowThisMonth ?? 0) >= 0;
  const has30d =
    wealth.spendingThisMonth != null && wealth.incomeThisMonth != null && wealth.cashflowThisMonth != null;
  const syncedDate = wealth.syncedAt
    ? new Date(wealth.syncedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;
  const show = (s: string) => (hidden ? MASK : s);

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <View style={styles.header}>
        <SectionHeader emoji="◆" title="Net Worth" tint="gold" />
        <Text style={[styles.hint, { color: c.subtext }]}>{hidden ? 'tap to show' : 'tap to hide'}</Text>
      </View>

      <Pressable onPress={() => setHidden((h) => !h)}>
        <Text style={[styles.big, { color: c.text }]}>{show(money(wealth.netWorth))}</Text>
        {!hidden && nwTrend.values.length >= 3 && (
          <View style={styles.nwTrend}>
            <Trend values={nwTrend.values} height={32} color={up ? c.green : c.red} max={30} />
          </View>
        )}
        {wealth.netWorthChange != null ? (
          <Text style={[styles.change, { color: hidden ? c.subtext : up ? c.green : c.red }]}>
            {hidden ? MASK : `${up ? '▲' : '▼'} ${money(Math.abs(wealth.netWorthChange))} over ~30 days`}
          </Text>
        ) : null}
        {planDelta != null && !hidden && (
          <Text style={[styles.change, { color: planDelta >= 0 ? c.green : c.red }]}>
            {`${planDelta >= 0 ? '▲' : '▼'} ${money(Math.abs(planDelta))} ${planDelta >= 0 ? 'ahead' : 'behind'} of plan pace`}
            {plan?.pctYearElapsed != null ? (
              <Text style={[styles.pacePct, { color: c.subtext }]}>{`  ·  ${plan.pctYearElapsed}% through 2026`}</Text>
            ) : null}
          </Text>
        )}
        {syncedDate && !hidden && (
          <Text style={[styles.syncedAt, { color: c.subtext }]}>as of {syncedDate}</Text>
        )}
      </Pressable>

      {has30d ? (
        <>
          <View style={[styles.row, { borderTopColor: c.border }]}>
            <Stat label="Income (30d)" value={show(money(wealth.incomeThisMonth!))} color={c.text} c={c} />
            <Stat label="Spending (30d)" value={show(money(wealth.spendingThisMonth!))} color={c.text} c={c} />
            <Stat
              label="Net (30d)"
              value={hidden ? MASK : `${cashflowMonthPositive ? '+' : '−'}${money(Math.abs(wealth.cashflowThisMonth!))}`}
              color={hidden ? c.text : cashflowMonthPositive ? c.green : c.red}
              c={c}
            />
          </View>
          {!hidden && wealth.incomeThisMonth! > 0 && (() => {
            const spendPct = Math.round((wealth.spendingThisMonth! / wealth.incomeThisMonth!) * 100);
            const savedPct = 100 - spendPct;
            return (
              <View style={styles.savingsWrap}>
                <View style={[styles.savingsTrack, { backgroundColor: c.green + '33' }]}>
                  <View style={[styles.savingsFill, { width: `${Math.min(100, Math.max(0, spendPct))}%`, backgroundColor: spendPct > 100 ? c.red : c.subtext }]} />
                </View>
                <Text style={[styles.savingsLabel, { color: c.subtext }]}>
                  {spendPct}% of income spent · {savedPct >= 0 ? `${savedPct}% saved` : `${Math.abs(savedPct)}% over`} (30d)
                </Text>
              </View>
            );
          })()}
          <Text style={[styles.discretionary, { color: c.subtext }]}>
            {show(money(wealth.spendingThisWeek))} spent in the last 7 days
            {wealth.discretionaryThisMonth != null && wealth.spendingThisMonth! > 0
              ? ` · ${show(money(wealth.discretionaryThisMonth))} discretionary (30d, ex rent/mortgage)`
              : ''}
          </Text>
        </>
      ) : (
        // Fallback for older payloads without 30-day fields.
        <View style={[styles.row, { borderTopColor: c.border }]}>
          <Stat label="Spending (7d)" value={show(money(wealth.spendingThisWeek))} color={c.text} c={c} />
          <Stat label="Income (7d)" value={show(money(wealth.incomeThisWeek))} color={c.text} c={c} />
          <Stat
            label="Net (7d)"
            value={hidden ? MASK : `${wealth.cashflowThisWeek >= 0 ? '+' : '−'}${money(Math.abs(wealth.cashflowThisWeek))}`}
            color={hidden ? c.text : wealth.cashflowThisWeek >= 0 ? c.green : c.red}
            c={c}
          />
        </View>
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
  big: { fontFamily: FONTS.displayLight, fontSize: 40, fontWeight: '300', letterSpacing: -1.5 },
  nwTrend: { marginTop: spacing.sm, marginBottom: 2 },
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
  savingsWrap: { marginTop: spacing.md },
  savingsTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  savingsFill: { height: 8, borderRadius: 4 },
  savingsLabel: { ...typography.caption, fontSize: 11, marginTop: spacing.xs, textAlign: 'center' },
  discretionary: { ...typography.caption, fontSize: 12, marginTop: spacing.sm, textAlign: 'center' },
  pacePct: { fontSize: 11 },
  syncedAt: { ...typography.caption, fontSize: 11, marginTop: 3 },
  monthRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
  monthLabel: { ...typography.caption, fontSize: 12 },
  monthValue: { ...typography.subtitle, fontWeight: '600', fontSize: 15 },
});

const WealthCardMemo = React.memo(WealthCard);
export { WealthCardMemo as WealthCard };
